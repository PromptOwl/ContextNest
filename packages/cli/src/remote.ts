/**
 * Remote nest routing for the ctx CLI.
 *
 * When `--vault <alias>` (or the env/default resolution) lands on a registry
 * `remotes:` entry, remote-capable commands route through here instead of
 * touching the local filesystem: each function maps the command onto the
 * canonical operation catalog and calls it over MCP via the engine's
 * `connectRemoteNest`.
 *
 * The JSON output of every remote branch is kept SHAPE-IDENTICAL to its local
 * counterpart in index.ts — that invariant is what lets the coding-agent
 * plugins (which parse `ctx … --json`) work against local and remote nests
 * interchangeably.
 */

import chalk from "./color.js";
import {
  ContextNestError,
  connectRemoteNest,
  normalizeDocumentId,
  normalizeStatus,
  resolveNest,
  serializeDocument,
  getRegistryDir,
  readRegistry,
} from "@promptowl/contextnest-engine";
import fs from "node:fs";
import pathMod from "node:path";
import type { ContextNode, RemoteNestConnection, RemoteNestSpec, VaultListEntry } from "@promptowl/contextnest-engine";
import { confirmOrExit, isDryRun } from "./safety.js";
import {
  listJsonEntry,
  queryJsonPayload,
  searchLimit,
  printSearchResults,
  titleFromId,
  parseTagsOption,
} from "./doc-views.js";

export interface RemoteTarget {
  alias: string;
  spec: RemoteNestSpec;
  /**
   * `--vault <server>/<nest>`: one nest behind a server-level (`…/mcp`) alias.
   * Every call is sent with that nest's id as the `nest` argument. `alias` is
   * the full `<server>/<nest>` form (for messages); the registry key is the
   * part before the slash.
   */
  nest?: string;
}

/**
 * Returns the remote target when vault resolution lands on a `remotes:` entry,
 * or null when it resolves locally. Remote-capable commands call this first;
 * local-only commands keep calling resolveVaultPath(), which throws a clear
 * error for remote aliases.
 */
export function remoteTarget(vaultAlias: string | undefined): RemoteTarget | null {
  const requested = vaultAlias ?? process.env.CONTEXTNEST_VAULT;
  const slash = requested?.indexOf("/") ?? -1;
  if (requested && slash > 0) {
    const base = requested.slice(0, slash);
    const nest = resolveNest({ vaultAlias: base, cwd: process.cwd() });
    if (nest.kind !== "remote") {
      throw new ContextNestError(
        `"${base}" is a local vault — only a remote server alias takes a /<nest> suffix.`,
        "CONFIG_ERROR",
      );
    }
    return { alias: requested, spec: nest.remote, nest: requested.slice(slash + 1) };
  }
  const nest = resolveNest({ vaultAlias, cwd: process.cwd() });
  return nest.kind === "remote" ? { alias: nest.alias, spec: nest.remote } : null;
}

// ─── Nests behind a server-level alias ──────────────────────────────────────

/** One nest as a Community server's `nest_index` reports it. */
export interface IndexedNest {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Pure: the `<nest>` label for each nest id — its slugged name, or
 * `<slug>-<id8>` when two nests the key can see slug the same (names are
 * unique per owner only, so a shared nest can collide with your own).
 */
export function nestLabels(nests: IndexedNest[]): Map<string, string> {
  const slug = (n: IndexedNest) =>
    n.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "nest";
  const counts = new Map<string, number>();
  for (const n of nests) counts.set(slug(n), (counts.get(slug(n)) ?? 0) + 1);
  return new Map(
    nests.map((n) => [n.id, counts.get(slug(n))! > 1 ? `${slug(n)}-${n.id.slice(0, 8)}` : slug(n)]),
  );
}

/** How long a server's nest list is reused before asking again. */
export const NEST_INDEX_TTL_MS = 5 * 60_000;

function nestCachePath(baseAlias: string): string {
  return pathMod.join(getRegistryDir(), "cache", `nests-${baseAlias}.json`);
}

/**
 * The nests behind a server-level alias, or null when the alias is an
 * ordinary single-nest endpoint (it advertises no `nest_index`). Cached per
 * alias for NEST_INDEX_TTL_MS so `ctx vault list` — which the plugin runs at
 * every session start — doesn't cost a round trip each time. The cache is a
 * convenience: unreadable or unwritable, it is simply skipped.
 */
/**
 * How long a failed nest-list probe is remembered. The plugin lists vaults on
 * every prompt; without this, an offline server costs a full timeout (or three,
 * for connect + listTools + nest_index on a slow one) on each of them.
 */
export const NEST_PROBE_BACKOFF_MS = 60_000;

export async function serverNests(
  baseAlias: string,
  spec: RemoteNestSpec,
  conn?: RemoteNestConnection,
  opts: { fresh?: boolean } = {},
): Promise<IndexedNest[] | null> {
  if (spec.transport !== "http") return null;
  const file = nestCachePath(baseAlias);
  const write = (entry: object) => {
    try {
      fs.mkdirSync(pathMod.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), url: spec.url, ...entry }));
    } catch {
      // best-effort
    }
  };
  if (!opts.fresh) {
    let cached: { at: number; url: string; nests?: IndexedNest[] | null; failed?: boolean } | undefined;
    try {
      cached = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      // no cache yet, or unreadable — ask the server
    }
    if (cached?.url === spec.url) {
      const age = Date.now() - cached.at;
      // A failed probe only short-circuits the next probes, not a caller that
      // already holds a live connection (that is proof the server is back).
      if (cached.failed && !conn && age < NEST_PROBE_BACKOFF_MS) {
        throw new ContextNestError(
          `Remote "${baseAlias}" was unreachable less than ${NEST_PROBE_BACKOFF_MS / 1000}s ago — not retrying yet.`,
          "REMOTE_UNREACHABLE",
        );
      }
      if (!cached.failed && age < NEST_INDEX_TTL_MS) return cached.nests ?? null;
    }
  }
  const fetchNests = async (c: RemoteNestConnection) =>
    (await c.toolNames()).has("nest_index")
      ? ((await c.run<{ nests?: IndexedNest[] }>("nest_index", {})).nests ?? [])
      : null;
  let nests: IndexedNest[] | null;
  try {
    nests = conn ? await fetchNests(conn) : await withRemote({ alias: baseAlias, spec }, fetchNests);
  } catch (err) {
    if (!conn) write({ failed: true });
    throw err;
  }
  write({ nests });
  return nests;
}

/** `--vault <server>/<nest>` → the nest id to send. Throws with the choices on a miss. */
async function resolveTargetNest(target: RemoteTarget, conn: RemoteNestConnection): Promise<string> {
  const base = target.alias.slice(0, target.alias.indexOf("/"));
  const wanted = target.nest!;
  // Exact label or id first. A plain name only counts when exactly one nest
  // carries it: two nests can share a name (unique per owner only), and
  // picking whichever the server lists first is how a write lands in the
  // wrong partner's nest. An ambiguous name falls through to the "Available:"
  // error, which lists the disambiguated labels.
  const find = (nests: IndexedNest[]) => {
    const labels = nestLabels(nests);
    const exact = nests.find((n) => labels.get(n.id) === wanted || n.id === wanted);
    if (exact) return exact;
    const named = nests.filter((n) => n.name.toLowerCase() === wanted.toLowerCase());
    return named.length === 1 ? named[0] : undefined;
  };
  let nests = await serverNests(base, target.spec, conn);
  // A nest created or shared since the cache was written: ask once more, fresh.
  if (nests && !find(nests)) nests = await serverNests(base, target.spec, conn, { fresh: true });
  if (nests === null) {
    throw new ContextNestError(
      `"${base}" is a single-nest endpoint, not a server — drop the "/${wanted}" suffix.`,
      "CONFIG_ERROR",
    );
  }
  const hit = find(nests);
  if (!hit) {
    const labels = [...nestLabels(nests).values()].map((l) => `${base}/${l}`);
    throw new ContextNestError(
      `No nest "${wanted}" on "${base}". Available: ${labels.join(", ") || "(none)"}.`,
      "CONFIG_ERROR",
    );
  }
  return hit.id;
}

/**
 * Connect, run, and always close — the standard remote command wrapper.
 * With a `<server>/<nest>` target, every call carries that nest's id.
 */
async function withRemote<T>(
  target: RemoteTarget,
  fn: (conn: RemoteNestConnection) => Promise<T>,
): Promise<T> {
  const conn = await connectRemoteNest(target.alias, target.spec);
  try {
    if (!target.nest) return await fn(conn);
    const nestId = await resolveTargetNest(target, conn);
    return await fn({ ...conn, run: (op, input) => conn.run(op, { ...input, nest: nestId }) });
  } catch (err) {
    // A write through a server-level alias with no nest named: say how to name one.
    // Coupled to contextnest-community's wording — the SDK's zod refusal of a
    // missing required `nest` ("invalid_type" … "nest" … "Required") or its own
    // "requires a `nest` argument". If that wording changes this stops firing
    // and the raw server error shows instead; the unit test pins the shape.
    if (
      !target.nest &&
      err instanceof ContextNestError &&
      /\bnest\b/.test(err.message) &&
      /requires|invalid_type|Required/i.test(err.message)
    ) {
      throw new ContextNestError(
        `"${target.alias}" spans several nests — name one with --vault ${target.alias}/<nest> (\`ctx vault list\` shows them).`,
        "VALIDATION_FAILED",
      );
    }
    throw err;
  } finally {
    await conn.close();
  }
}

/**
 * Hits from a server-level fan-out carry `nest: {id, name}`. Turn that into
 * `vault: "<server>/<nest>"` — the exact --vault that addresses the hit's
 * nest — so a caller (the coding-agent plugins) can cite and edit it.
 */
async function labelFanout<T extends { nest?: unknown }>(
  target: RemoteTarget,
  conn: RemoteNestConnection,
  items: T[],
): Promise<Array<T & { vault?: string }>> {
  if (target.nest || !items.some((i) => i.nest && typeof i.nest === "object")) return items;
  const labels = nestLabels((await serverNests(target.alias, target.spec, conn)) ?? []);
  return items.map((i) => {
    const n = i.nest as { id?: string } | undefined;
    const label = n?.id ? labels.get(n.id) : undefined;
    return label ? { ...i, vault: `${target.alias}/${label}` } : i;
  });
}

// Wire shapes of the catalog operations this module consumes.
interface NodeSummary {
  id: string;
  title: string;
  description?: string;
  type?: string;
  status?: string;
  tags?: string[];
  body?: string;
  source?: Record<string, unknown>;
  /** BM25 relevance score; absent from a nest running an older engine. */
  score?: number;
  /** Server-level fan-out only: the nest the hit came from. */
  nest?: { id: string; name: string };
  /** Set by labelFanout: the `--vault <server>/<nest>` that addresses this hit. */
  vault?: string;
}

// ─── Read surface ───────────────────────────────────────────────────────────

export async function remoteList(
  target: RemoteTarget,
  opts: { type?: string; status?: string; tag?: string; limit?: number; json?: boolean },
): Promise<void> {
  await withRemote(target, async (conn) => {
    // Filters go to the NEST, exactly as they do locally. Re-deciding them here
    // would be a second implementation of filters.ts (they drifted on tag case
    // once already), and it cannot recover documents the nest already withheld
    // — an unfiltered context_list hides retired docs, so a client-side
    // `--status rejected` could only ever return nothing.
    const out = await conn.run<{ documents: NodeSummary[] }>("context_list", {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.status ? { status: normalizeStatus(opts.status) } : {}),
      ...(opts.tag ? { tag: opts.tag } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    const docs = await labelFanout(target, conn, out.documents);

    if (opts.json) {
      console.log(JSON.stringify(docs.map(listJsonEntry), null, 2));
      return;
    }
    if (docs.length === 0) {
      console.log(chalk.yellow("No documents found."));
      return;
    }
    console.log(chalk.bold(`${docs.length} document(s):\n`));
    for (const d of docs) {
      console.log(`  ${chalk.cyan(d.vault ? `${d.vault}:${d.id}` : d.id)} [${d.type || "document"}] ${d.status || "draft"}`);
      console.log(`    ${d.title}`);
    }
  });
}

export async function remoteQuery(
  target: RemoteTarget,
  selector: string,
  opts: { json?: boolean; hops?: number; full?: boolean; includeDrafts?: boolean },
): Promise<void> {
  await withRemote(target, async (conn) => {
    // Same input the local branch builds: omit what wasn't asked for so the
    // nest applies its own defaults rather than ours.
    const out = await conn.run<{
      documents: NodeSummary[];
      source_nodes?: NodeSummary[];
      traversal?: { mode: string; hops_used: number; nodes_traversed: number };
      trace_count?: number;
    }>("context_query", {
      query: selector,
      ...(opts.hops !== undefined ? { hops: opts.hops } : {}),
      ...(opts.full ? { full: true } : {}),
      ...(opts.includeDrafts ? { include_drafts: true } : {}),
    });

    out.documents = await labelFanout(target, conn, out.documents);
    // Source nodes can come from a different nest than the matches — label them too.
    const sourceNodes = await labelFanout(target, conn, out.source_nodes ?? []);
    if (opts.json) {
      // Field selection shared with the local branch (doc-views.ts).
      console.log(
        JSON.stringify(
          queryJsonPayload({
            documents: out.documents,
            sourceNodes,
            traceCount: out.trace_count ?? 0,
            mode: out.traversal?.mode,
            hopsUsed: out.traversal?.hops_used,
            nodesTraversed: out.traversal?.nodes_traversed,
          }),
          null,
          2,
        ),
      );
      return;
    }
    console.log(chalk.bold("Documents:"));
    for (const doc of out.documents) {
      console.log(`  ${chalk.cyan(doc.vault ? `${doc.vault}:${doc.id}` : doc.id)}: ${doc.title}`);
    }
    if (sourceNodes.length > 0) {
      console.log(chalk.bold("\nSource Nodes (hydration order):"));
      for (const doc of sourceNodes) {
        console.log(`  ${chalk.magenta(doc.vault ? `${doc.vault}:${doc.id}` : doc.id)}: ${doc.title}`);
      }
    }
    console.log(
      chalk.dim(
        `\n${out.traversal?.mode} mode | ${out.traversal?.hops_used} hops | ${out.traversal?.nodes_traversed} nodes | remote: ${target.alias}`,
      ),
    );
  });
}

export async function remoteSearch(
  target: RemoteTarget,
  query: string,
  opts: { json?: boolean; limit?: number },
): Promise<void> {
  await withRemote(target, async (conn) => {
    const limit = searchLimit(opts.limit);
    const out = await conn.run<{ results: NodeSummary[]; total?: number }>("context_search", {
      query,
      ...(limit ? { limit } : {}),
    });
    // Rendering shared with the local branch (doc-views.ts). An older remote
    // engine sends neither `score` nor `total`; both degrade to the previous
    // output.
    printSearchResults({ ...out, results: await labelFanout(target, conn, out.results) }, opts);
  });
}

export async function remoteRead(
  target: RemoteTarget,
  path: string,
  opts: { raw?: boolean; html?: boolean },
): Promise<void> {
  if (opts.html) {
    throw new ContextNestError(
      `--html is not supported against a remote nest yet — use \`ctx read ${path} --raw\` or run against a local vault.`,
      "NOT_IMPLEMENTED",
    );
  }
  await withRemote(target, async (conn) => {
    const doc = await conn.run<{
      id: string;
      frontmatter: Record<string, any>;
      body: string;
      raw?: string;
    }>("context_get", { id: normalizeDocumentId(path), include_raw: Boolean(opts.raw) });

    if (opts.raw) {
      // A nest that returns no `raw` (contextnest-community's context_get has
      // no include_raw) used to print nothing here — and the plugin's
      // sweep-check reads every candidate this way, so it found nothing on a
      // remote nest. Rebuild the file from what did come back.
      console.log(doc.raw ?? serializeDocument({ id: doc.id, frontmatter: doc.frontmatter, body: doc.body } as ContextNode));
      return;
    }
    const fm = doc.frontmatter;
    console.log(chalk.bold.underline(fm.title));
    console.log();
    const meta: string[] = [];
    if (fm.type) meta.push(`${chalk.dim("type:")} ${fm.type}`);
    if (fm.status) meta.push(`${chalk.dim("status:")} ${fm.status}`);
    if (fm.version) meta.push(`${chalk.dim("v")}${fm.version}`);
    if (meta.length) console.log(meta.join("  "));
    if (fm.tags?.length) {
      console.log(chalk.dim("tags:") + " " + fm.tags.map((t: string) => chalk.cyan(t)).join(" "));
    }
    console.log(chalk.dim("─".repeat(60)));
    console.log(doc.body.trim());
  });
}

/**
 * NOT AVAILABLE against a Community-hosted nest (contextnest-community):
 * that server registers no `context_verify` tool and has no equivalent to
 * route to, so this fails with "Tool context_verify not found". Works against
 * a catalog-bound OSS server (@promptowl/contextnest-mcp-server), which does
 * expose the op.
 */
export async function remoteVerify(
  target: RemoteTarget,
  opts: { json?: boolean },
): Promise<void> {
  // Return the verdict out of the withRemote callback and exit AFTER it — a
  // process.exit inside the callback would skip the finally that closes the
  // connection (and with it, the spawned stdio server).
  const valid = await withRemote(target, async (conn) => {
    // A nest that enforces integrity server-side publishes no hash chain for a
    // client to walk, so there is no check to run from here. Refuse: emitting
    // {valid: true} would report a pass for a verification that never happened.
    if (!(await conn.toolNames()).has("context_verify")) {
      throw new ContextNestError(
        `Remote nest "${target.alias}" does not expose context_verify — this nest enforces integrity ` +
          `server-side, so there is no hash chain for the client to walk. Nothing was verified.`,
        "NOT_IMPLEMENTED",
      );
    }
    const report = await conn.run<{ valid: boolean; errors: unknown[] }>("context_verify", {});
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        report.valid
          ? chalk.green("All integrity checks passed")
          : chalk.red(`${report.errors.length} integrity error(s) found`),
      );
    }
    return report.valid;
  });
  if (!valid) process.exit(1);
}

export async function remoteHistory(
  target: RemoteTarget,
  path: string,
  opts: { json?: boolean; diff?: boolean },
): Promise<void> {
  await withRemote(target, async (conn) => {
    const out = await conn.run<{
      id: string;
      keyframe_interval?: number;
      approved_version?: number | null;
      versions: Array<Record<string, unknown>>;
    }>("context_versions", {
      id: normalizeDocumentId(path),
      ...(opts.diff ? { include_diff: true } : {}),
    });

    if (out.versions.length === 0) {
      console.log(chalk.yellow(`No version history for ${out.id}`));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log(chalk.bold(`Version history for ${out.id}:\n`));
    for (const entry of out.versions) {
      const keyframe = entry.keyframe ? chalk.blue(" [keyframe]") : "";
      // A nest that approves rather than publishes reports a per-version
      // `status` and names its serving version in `approved_version`; reading
      // only `published_at` labelled every one of those versions "draft".
      const state =
        typeof entry.status === "string"
          ? (entry.version === out.approved_version
              ? chalk.green(` ${entry.status} (AI-active)`)
              : chalk.yellow(` ${entry.status}`))
          : entry.published_at
            ? chalk.green(" published")
            : chalk.yellow(" draft");
      console.log(`  v${entry.version}${keyframe}${state}`);
      console.log(`    By: ${entry.edited_by} at ${entry.edited_at}`);
      if (entry.note) console.log(`    Note: ${entry.note}`);
    }
  });
}

// ─── Write surface ──────────────────────────────────────────────────────────

/**
 * Confirm a write that lands on someone else's nest.
 *
 * --dry-run refuses outright: the sandbox only ever shadows a LOCAL vault, so
 * there is nothing here to preview against — proceeding would write for real.
 */
async function confirmRemoteWrite(
  target: RemoteTarget,
  question: string,
  opts?: { destructive?: boolean },
): Promise<void> {
  if (isDryRun()) {
    throw new ContextNestError(
      `--dry-run cannot preview a write to remote nest "${target.alias}" — the sandbox only shadows a local vault.`,
      "NOT_IMPLEMENTED",
    );
  }
  await confirmOrExit(question, opts);
}

/**
 * Folder segment of a document id — everything between the `nodes/` root and
 * the final slug. `nodes/repo/thing` -> `repo`; `nodes/thing` -> `""`.
 */
export function folderFromId(id: string): string {
  const segments = id.split("/");
  if (segments[0] === "nodes") segments.shift();
  segments.pop();
  return segments.join("/");
}

export async function remoteAdd(
  target: RemoteTarget,
  path: string,
  opts: { type?: string; title?: string; tags?: string; body?: string; trigger?: string },
): Promise<void> {
  if (opts.type === "skill") {
    throw new ContextNestError(
      "Creating skill nodes on a remote nest is not supported yet — run against a local vault.",
      "NOT_IMPLEMENTED",
    );
  }
  await confirmRemoteWrite(target, `Create ${normalizeDocumentId(path)} on remote nest "${target.alias}" and publish v1?`);
  await withRemote(target, async (conn) => {
    const id = normalizeDocumentId(path);
    // Title derivation + tag parsing shared with the local branch
    // (doc-views.ts), so `ctx add nodes/foo-bar` behaves identically
    // wherever it runs.
    const title = opts.title || titleFromId(id);
    const tags = opts.tags ? parseTagsOption(opts.tags) : undefined;

    const input: Record<string, unknown> = {
      id,
      title,
      content: opts.body ? `\n${opts.body}\n` : `\n# ${title}\n\n`,
    };
    // Send the folder alongside the id. A nest whose `context_create` predates
    // the catalog's `id` parameter drops that key and derives the id from the
    // title alone, filing every remote `ctx add nodes/<folder>/<slug>` flat at
    // the nest root; `folder` has been in the op the whole time. A catalog-
    // conformant nest is unaffected — an explicit `id` overrides `folder`.
    const folder = folderFromId(id);
    if (folder) input.folder = folder;
    if (opts.type) input.type = opts.type;
    if (tags) input.tags = tags;

    const created = await conn.run<{ id: string; version: number }>("context_create", input);
    console.log(chalk.green(`Created and published ${created.id}.md (remote: ${target.alias})`));
    console.log(`  Version: ${created.version}`);
  });
}

export async function remoteUpdate(
  target: RemoteTarget,
  path: string,
  opts: { title?: string; tags?: string; status?: string; body?: string },
): Promise<void> {
  // A rename stays refused: Community's context_update reads `title` as the
  // node SELECTOR, so sending it next to `id` would be silently ignored.
  if (opts.title !== undefined) {
    throw new ContextNestError(
      "--title is not supported against a remote nest yet (the nest reads `title` as a selector, not a rename) — rename it in the app.",
      "NOT_IMPLEMENTED",
    );
  }
  if (opts.body === undefined && opts.tags === undefined && opts.status === undefined) {
    throw new ContextNestError("Nothing to update — pass --body, --tags or --status.", "VALIDATION_FAILED");
  }
  await confirmRemoteWrite(
    target,
    `Update ${normalizeDocumentId(path)} on remote nest "${target.alias}"? The previous content stays recoverable from its version history.`,
  );
  await withRemote(target, async (conn) => {
    // Same fields the local branch sends; tags REPLACE, as locally.
    const updated = await conn.run<{ id: string; version: number; status?: string }>("context_update", {
      id: normalizeDocumentId(path),
      ...(opts.body !== undefined ? { content: `\n${opts.body}\n` } : {}),
      ...(opts.tags !== undefined ? { tags: parseTagsOption(opts.tags) } : {}),
      ...(opts.status !== undefined ? { status: normalizeStatus(opts.status) } : {}),
    });
    // The nest's stewardship decides whether the edit published, so report
    // the status it came back with rather than assuming "published".
    console.log(chalk.green(`Updated ${updated.id} (remote: ${target.alias})`));
    console.log(`  Version: ${updated.version}`);
    if (updated.status) console.log(`  Status: ${updated.status}`);
  });
}

/**
 * NOT AVAILABLE against a Community-hosted nest (contextnest-community):
 * that server registers no `context_publish` tool — it publishes through
 * steward review (`context_submit_review` → `context_approve`, which calls the
 * engine's publish op server-side), so this fails with "Tool context_publish
 * not found". Works against a catalog-bound OSS server, which exposes the op.
 */
export async function remotePublish(
  target: RemoteTarget,
  path: string | undefined,
  opts: { all?: boolean; message?: string } = {},
): Promise<void> {
  // Refuse loudly rather than crash: --all leaves `path` undefined, and the
  // catalog's publish op takes neither a batch nor a version note.
  if (opts.all) {
    throw new ContextNestError(
      `Publishing the whole nest at once is not supported against a remote nest — publish documents individually, or run against a local vault.`,
      "NOT_IMPLEMENTED",
    );
  }
  if (!path) {
    throw new ContextNestError("Nothing to publish — pass a document path.", "VALIDATION_FAILED");
  }
  const id = normalizeDocumentId(path);
  // Probe capabilities on a connection of its own: confirmRemoteWrite exits the
  // process on a decline, which would skip the close() in withRemote's finally.
  const tools = await withRemote(target, (conn) => conn.toolNames());

  if (!tools.has("context_publish")) {
    // A governed nest has no direct publish — that would bypass its review
    // plane. A node goes context_submit_review -> a steward's context_approve,
    // so route there instead of failing, and never let the output read as live.
    if (!tools.has("context_submit_review")) {
      throw new ContextNestError(
        `Remote nest "${target.alias}" exposes neither context_publish nor context_submit_review — ` +
          `it offers no publish path this client can drive. Nothing was published.`,
        "NOT_IMPLEMENTED",
      );
    }
    await confirmRemoteWrite(
      target,
      `Submit ${id} for steward review on remote nest "${target.alias}"? ` +
        `This nest publishes through review, so this will NOT make the node live.`,
    );
    await withRemote(target, async (conn) => {
      // context_submit_review keys on title, not id — resolve it rather than
      // guess, using the same context_get call remoteRead already makes.
      const doc = await conn.run<{ frontmatter: { title?: string } }>("context_get", { id });
      const title = doc.frontmatter?.title;
      if (!title) {
        throw new ContextNestError(
          `Cannot submit ${id} for review — the remote returned no title to submit it by.`,
          "INTERNAL",
        );
      }
      // Unlike context_publish, this op DOES carry a note — map --message onto it.
      const out = await conn.run<{
        id: string;
        review?: { id?: string; version?: number; status?: string; priority?: string };
      }>("context_submit_review", { title, ...(opts.message ? { note: opts.message } : {}) });
      const review = out.review ?? {};
      console.log(chalk.green(`Submitted ${out.id ?? id} for steward review (remote: ${target.alias})`));
      if (review.version !== undefined) console.log(`  Version: ${review.version}`);
      if (review.status) {
        console.log(`  Review: ${review.status}${review.priority ? ` (${review.priority} priority)` : ""}`);
      }
      if (review.id) console.log(`  Request: ${review.id}`);
      console.log(
        chalk.yellow(
          "  NOT published — this nest publishes through review. The node is not live until a steward approves it.",
        ),
      );
    });
    return;
  }

  // The catalog's publish op takes no version note (context_submit_review, above, does).
  if (opts.message !== undefined) {
    throw new ContextNestError(
      "--message is not supported against a remote nest yet (the catalog's publish operation takes no version note).",
      "NOT_IMPLEMENTED",
    );
  }
  await confirmRemoteWrite(target, `Publish ${id} on remote nest "${target.alias}"?`);
  await withRemote(target, async (conn) => {
    const out = await conn.run<{ id: string; version: number; checkpoint: number }>(
      "context_publish",
      { id },
    );
    console.log(chalk.green(`Published ${out.id} (remote: ${target.alias})`));
    console.log(`  Version: ${out.version}`);
    console.log(`  Checkpoint: ${out.checkpoint}`);
  });
}

export async function remoteDelete(target: RemoteTarget, path: string): Promise<void> {
  await confirmRemoteWrite(
    target,
    `Delete ${normalizeDocumentId(path)} and its version history from remote nest "${target.alias}"? This cannot be undone.`,
    { destructive: true },
  );
  await withRemote(target, async (conn) => {
    const out = await conn.run<{ id: string; deleted: true }>("context_delete", {
      id: normalizeDocumentId(path),
    });
    console.log(chalk.green(`Deleted ${out.id} (remote: ${target.alias})`));
  });
}

/**
 * Community-only: `context_move` is not a catalog operation (the id rewrite
 * spans governance tables the engine doesn't own), so a nest that lacks it
 * answers "tool not found".
 */
export async function remoteMove(target: RemoteTarget, path: string, folder: string): Promise<void> {
  await confirmRemoteWrite(
    target,
    `Move ${normalizeDocumentId(path)} to folder "${folder}" on remote nest "${target.alias}"? Its id changes; history and links follow.`,
  );
  await withRemote(target, async (conn) => {
    const out = await conn.run<{ id: string; previous_id: string }>("context_move", {
      id: normalizeDocumentId(path),
      folder,
    });
    console.log(chalk.green(`Moved ${out.previous_id} → ${out.id} (remote: ${target.alias})`));
  });
}

// ─── ctx vault list: nests behind a server alias ────────────────────────────

/** A `ctx vault list` row: the registry's own, or a nest behind a server alias. */
export type VaultRow = VaultListEntry & {
  /** Nest rows only: the server alias they sit behind. */
  parent?: string;
  nest?: { id: string; name: string };
};

/** A listing must not stall on a dead server — the plugin runs it at every session start. */
const LIST_PROBE_TIMEOUT_MS = 5_000;

/**
 * Insert one `<server>/<nest>` row after every server-level remote, so anything
 * that picks a vault from the list (a person, or the plugin's agents choosing
 * by description) sees each nest with its own description. The server row
 * stays — it is how reads span every nest at once. A server that can't be
 * reached is listed as it is, without nest rows.
 */
export async function expandServerVaults(vaults: VaultListEntry[]): Promise<VaultRow[]> {
  const registry = readRegistry();
  // Probe every server at once: a dead one then costs one timeout per listing,
  // not one per dead server.
  const probes = await Promise.all(
    vaults.map(async (v): Promise<IndexedNest[] | null> => {
      const spec = registry.remotes?.[v.alias];
      if (v.kind !== "remote" || spec?.transport !== "http") return null;
      try {
        // An unreachable server costs one probe timeout, then is skipped for
        // NEST_PROBE_BACKOFF_MS (serverNests remembers the failure).
        return await serverNests(v.alias, {
          ...spec,
          timeout_ms: Math.min(spec.timeout_ms ?? LIST_PROBE_TIMEOUT_MS, LIST_PROBE_TIMEOUT_MS),
        });
      } catch {
        return null;
      }
    }),
  );
  const rows: VaultRow[] = [];
  vaults.forEach((v, i) => {
    const nests = probes[i];
    if (!nests) {
      rows.push(v);
      return;
    }
    rows.push({ ...v, description: v.description || `All ${nests.length} nest(s) on this server — reads span every nest` });
    const labels = nestLabels(nests);
    for (const n of nests) {
      rows.push({
        alias: `${v.alias}/${labels.get(n.id)}`,
        kind: "remote",
        transport: "http",
        url: v.url,
        description: n.description?.trim() || n.name,
        isDefault: false,
        parent: v.alias,
        nest: { id: n.id, name: n.name },
      });
    }
  });
  return rows;
}
