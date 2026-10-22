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
import { parseRecipeManifest, manifestSources } from "./pull.js";
import type { FetchedRecipe, SourceNode } from "./pull.js";
import {
  TASK_FIELD_FLAGS,
  hasTaskFieldArgs,
  requireTaskSupport,
  taskFieldArgs,
  taskFieldsSuffix,
  taskListFilters,
} from "./task-fields.js";
import {
  listJsonEntry,
  queryJsonPayload,
  searchLimit,
  printSearchResults,
  titleFromId,
  documentId,
  parseTagsOption,
  printStructure,
  type StructureOutput,
} from "./doc-views.js";
import { savedTokenFor, savedTokensForServer } from "./server-credentials.js";

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
 * A name as a label: lower case, every run of other characters one "-", no
 * "-" at either end — trimmed with a loop, since `/^-+|-+$/` retries from
 * every dash of a run that does not end the name.
 */
export function slugLabel(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "-") start++;
  while (end > start && s[end - 1] === "-") end--;
  return s.slice(start, end);
}

/**
 * Pure: the `<nest>` label for each nest id — its slugged name, or
 * `<slug>-<id8>` when two nests the key can see slug the same (names are
 * unique per owner only, so a shared nest can collide with your own).
 */
export function nestLabels(nests: IndexedNest[]): Map<string, string> {
  const slug = (n: IndexedNest) => slugLabel(n.name) || "nest";
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

/** What a cached nest list was fetched for: the URL, and the account whose keys saw it. */
function nestCacheUrl(spec: Extract<RemoteNestSpec, { transport: "http" }>): string {
  return spec.account ? `${spec.url}#${spec.account}` : spec.url;
}

/**
 * How long a failed nest-list probe is remembered. The plugin lists vaults on
 * every prompt; without this, an offline server costs a full timeout (or three,
 * for connect + listTools + nest_index on a slow one) on each of them.
 */
export const NEST_PROBE_BACKOFF_MS = 60_000;

/**
 * The nests behind a server-level alias, or null when the alias is an
 * ordinary single-nest endpoint (it advertises no `nest_index`). Cached per
 * alias for NEST_INDEX_TTL_MS so `ctx vault list` — which the plugin runs at
 * every session start — doesn't cost a round trip each time. The cache is a
 * convenience: unreadable or unwritable, it is simply skipped.
 */
export async function serverNests(
  baseAlias: string,
  spec: RemoteNestSpec,
  conn?: RemoteNestConnection,
  /** `retry`: probe even inside the failure backoff — a command naming a nest, not a listing. */
  opts: { fresh?: boolean; retry?: boolean } = {},
): Promise<IndexedNest[] | null> {
  if (spec.transport !== "http") return null;
  const file = nestCachePath(baseAlias);
  const write = (entry: object) => {
    try {
      fs.mkdirSync(pathMod.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), url: nestCacheUrl(spec), ...entry }));
    } catch {
      // best-effort
    }
  };
  const cached = readNestCache(baseAlias, nestCacheUrl(spec));
  if (!opts.fresh) {
    if (cached) {
      const age = Date.now() - cached.at;
      // A failed probe only short-circuits the next probes, not a caller that
      // already holds a live connection (that is proof the server is back).
      if (cached.failed && !conn && !opts.retry && age < NEST_PROBE_BACKOFF_MS) {
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
    nests = conn ? await fetchNests(conn) : await nestsOverSavedKeys(baseAlias, spec, fetchNests);
  } catch (err) {
    // Keep the last good list: a listing can still show it while the server is down.
    if (!conn) write({ failed: true, ...(cached?.nests ? { nests: cached.nests } : {}) });
    throw err;
  }
  write({ nests });
  return nests;
}

/**
 * The nests every saved key of the alias's account can see, one connection per
 * key. A nest-scoped key — perhaps another user's, shared for one nest — sees
 * only its nest, so the server-wide key alone can miss it. A key that fails is
 * skipped while another still answers.
 */
async function nestsOverSavedKeys(
  alias: string,
  spec: RemoteNestSpec,
  fetchNests: (c: RemoteNestConnection) => Promise<IndexedNest[] | null>,
): Promise<IndexedNest[] | null> {
  let tokens: string[] = [];
  const http = wantsLoginKey(spec) ? spec : undefined;
  if (http) {
    try {
      tokens = await savedTokensForServer(http.url, http.account);
    } catch {
      // Unreadable store: withRemote's connect reports it if the server wants a key.
    }
  }
  if (!http || tokens.length === 0) return withRemote({ alias, spec }, fetchNests);
  const lists = await Promise.allSettled(
    tokens.map(async (token) => {
      const c = await connectWithToken(alias, http, token, connectRemoteNest);
      try {
        return await fetchNests(c);
      } finally {
        await c.close();
      }
    }),
  );
  const ok = lists.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (ok.length === 0) throw (lists[0] as PromiseRejectedResult).reason;
  if (ok.every((n) => n === null)) return null;
  const byId = new Map<string, IndexedNest>();
  for (const n of ok.flat()) if (n && !byId.has(n.id)) byId.set(n.id, n);
  return [...byId.values()];
}

type NestCache = { at: number; url: string; nests?: IndexedNest[] | null; failed?: boolean };

/** The cached probe for this alias and URL; undefined when there is none or it is unreadable. */
function readNestCache(baseAlias: string, url: string): NestCache | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(nestCachePath(baseAlias), "utf-8")) as NestCache;
    return cached.url === url ? cached : undefined;
  } catch {
    return undefined;
  }
}

/** `--vault <server>/<nest>` → the nest id to send. Throws with the choices on a miss. */
async function resolveTargetNest(target: RemoteTarget): Promise<string> {
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
  // Resolved before connecting: the nest decides which saved key to sign in with.
  let nests = await serverNests(base, target.spec, undefined, { retry: true });
  // A nest created or shared since the cache was written: ask once more, fresh.
  if (nests && !find(nests)) nests = await serverNests(base, target.spec, undefined, { fresh: true });
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

/** Env var name the saved `ctx login` key is handed to the engine under. */
export const LOGIN_TOKEN_ENV = "CONTEXTNEST_LOGIN_TOKEN";

/**
 * Whether a remote should borrow the `ctx login` key: only an HTTP remote
 * registered with NO auth. Explicit registry auth (bearer_env / header_env)
 * always wins, and stdio remotes never carry a bearer.
 */
export function wantsLoginKey(spec: RemoteNestSpec): spec is Extract<RemoteNestSpec, { transport: "http" }> {
  return spec.transport === "http" && !spec.auth;
}

/** Saved-key lookup for an endpoint, under the alias's `account`. `fresh` bypasses the login-state marker. */
export type LoginLookup = (url: string, account?: string, fresh?: boolean) => Promise<string | null>;

/**
 * Connect to a remote. An HTTP remote registered without auth borrows the key
 * `ctx login` saved for its server, so `ctx vault add <alias> --url <server>/mcp`
 * needs no --bearer-env once you're logged in. With `nestId` (a server alias
 * naming one nest) the key is the one saved for that nest, else the server-wide
 * one: the server accepts a nest-scoped key on `<server>/mcp` for its nest.
 */
export async function connectTarget(
  target: RemoteTarget,
  lookup: LoginLookup = (url, account, fresh) => savedTokenFor(url, { fresh }, account),
  connect: typeof connectRemoteNest = connectRemoteNest,
  nestId?: string,
): Promise<RemoteNestConnection> {
  try {
    return await connectWithLogin(target, lookup, connect, nestId);
  } catch (err) {
    throw nestPathHint(target.spec, err);
  }
}

/**
 * A Community nest lives at `/nests/<id>/mcp`; the singular `/nest/<id>/mcp`
 * 404s and would otherwise read as a bare "unreachable". Name the fix.
 */
export function nestPathHint(spec: RemoteNestSpec, err: unknown): unknown {
  if (!(err instanceof ContextNestError) || err.code !== "REMOTE_UNREACHABLE" || spec.transport !== "http") return err;
  const fixed = spec.url.replace(/\/nest\/([^/]+)\/mcp\/?$/, "/nests/$1/mcp");
  if (fixed === spec.url) return err;
  return new ContextNestError(
    `${err.message}\n  Nest endpoints are /nests/<id>/mcp (plural) — did you mean ${fixed} ?`,
    err.code,
  );
}

async function connectWithLogin(
  target: RemoteTarget,
  lookup: LoginLookup,
  connect: typeof connectRemoteNest,
  nestId: string | undefined,
): Promise<RemoteNestConnection> {
  const { spec } = target;
  if (!wantsLoginKey(spec)) return connect(target.alias, spec);
  let token: string | null = null;
  let storeError: Error | undefined;
  const url = nestId ? `${spec.url.replace(/\/mcp\/?$/, "")}/nests/${encodeURIComponent(nestId)}` : spec.url;
  try {
    token = await lookup(url, spec.account);
  } catch (err) {
    storeError = err as Error;
  }
  if (!token) {
    // An unreadable store must not break a remote that needs no key; it only
    // matters once the server asks for one, and then it is the real cause.
    try {
      return await connect(target.alias, spec);
    } catch (err) {
      if (err instanceof ContextNestError && err.code === "REMOTE_AUTH_FAILED") {
        if (!storeError) {
          // The lookup may have trusted a stale "nothing saved" marker: read the store itself once.
          try {
            token = await lookup(url, spec.account, true);
          } catch (e) {
            storeError = e as Error;
          }
          if (token) return connectWithToken(target.alias, spec, token, connect);
        }
        if (storeError) throw new ContextNestError(storeError.message, "CONFIG_ERROR");
        // A key saved for one nest signs in only as `<alias>/<nest>`, never for the whole server.
        const serverAlias = !nestId && !/\/nests\/[^/]+\/mcp\/?$/.test(spec.url);
        let message = `${err.message} Or sign in once: \`ctx login <server>\`.`;
        if (serverAlias) message += ` A key saved for one nest works as --vault ${target.alias}/<nest>.`;
        throw new ContextNestError(message, err.code);
      }
      throw err;
    }
  }
  return connectWithToken(target.alias, spec, token, connect);
}

/** Connect to an HTTP remote with a saved `ctx login` key. */
async function connectWithToken(
  alias: string,
  spec: Extract<RemoteNestSpec, { transport: "http" }>,
  token: string,
  connect: typeof connectRemoteNest,
): Promise<RemoteNestConnection> {
  try {
    // The engine reads bearers from env-var references only, so hand it the key
    // under a private name rather than widening the registry format.
    return await connect(
      alias,
      { ...spec, auth: { bearer_env: LOGIN_TOKEN_ENV } },
      { ...process.env, [LOGIN_TOKEN_ENV]: token },
    );
  } catch (err) {
    // The engine's message would point at our internal env var; point at the fix instead.
    if (err instanceof ContextNestError && err.code === "REMOTE_AUTH_FAILED") {
      throw new ContextNestError(
        `Remote nest "${alias}" rejected the key saved by \`ctx login\` — run \`ctx login <server>\` again.`,
        "REMOTE_AUTH_FAILED",
      );
    }
    throw err;
  }
}

/**
 * Connect, run, and always close — the standard remote command wrapper.
 * With a `<server>/<nest>` target, every call carries that nest's id.
 */
async function withRemote<T>(
  target: RemoteTarget,
  fn: (conn: RemoteNestConnection, nestId?: string) => Promise<T>,
): Promise<T> {
  const nestId = target.nest ? await resolveTargetNest(target) : undefined;
  const conn = await connectTarget(target, undefined, undefined, nestId);
  try {
    if (!nestId) return await fn(conn);
    return await fn({ ...conn, run: (op, input) => conn.run(op, { ...input, nest: nestId }) }, nestId);
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
  /** Task (board) fields — reported by a Community nest when set. */
  assignee?: string;
  due?: string;
  priority?: string;
  parent?: string;
}

// ─── Read surface ───────────────────────────────────────────────────────────

export async function remoteList(
  target: RemoteTarget,
  opts: {
    type?: string;
    status?: string;
    tag?: string;
    limit?: number;
    json?: boolean;
    assignee?: string;
    priority?: string;
    dueBefore?: string;
  },
): Promise<void> {
  await withRemote(target, async (conn) => {
    // Filters go to the NEST, exactly as they do locally. Re-deciding them here
    // would be a second implementation of filters.ts (they drifted on tag case
    // once already), and it cannot recover documents the nest already withheld
    // — an unfiltered context_list hides retired docs, so a client-side
    // `--status rejected` could only ever return nothing.
    const taskFilters = taskListFilters(opts);
    if (Object.keys(taskFilters).length) await requireTaskSupport(conn, target.alias);
    const out = await conn.run<{ documents: NodeSummary[] }>("context_list", {
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.status ? { status: normalizeStatus(opts.status) } : {}),
      ...(opts.tag ? { tag: opts.tag } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      // Task filters, like the rest, are decided by the nest.
      ...taskFilters,
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
      console.log(`  ${chalk.cyan(d.vault ? `${d.vault}:${d.id}` : d.id)} [${d.type || "document"}] ${d.status || "draft"}${chalk.dim(taskFieldsSuffix(d))}`);
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
  opts: { json?: boolean; limit?: number; mode?: string; rerank?: boolean },
): Promise<void> {
  await withRemote(target, async (conn) => {
    const limit = searchLimit(opts.limit);
    // mode/rerank are sent only when asked for: a server on an older engine
    // refuses unknown keys, and a plain search must keep working against it.
    const out = await conn.run<{ results: NodeSummary[]; count?: number; total?: number }>("context_search", {
      query,
      ...(limit ? { limit } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.rerank ? { rerank: true } : {}),
    });
    // Rendering shared with the local branch (doc-views.ts). A remote may
    // send `count`, only the deprecated `total`, or (an older engine) neither
    // and no `score`; each degrades to the previous output.
    printSearchResults({ ...out, results: await labelFanout(target, conn, out.results) }, opts);
  });
}

/**
 * `ctx embed` against a remote nest: run its `context_embed` when it offers
 * one; otherwise refuse — the nest builds its own index, and embedding a
 * local folder instead would report success for the wrong vault.
 */
export async function remoteEmbed<T>(target: RemoteTarget, input: { rebuild?: true }): Promise<T> {
  return withRemote(target, async (conn) => {
    if (!(await conn.toolNames()).has("context_embed")) {
      throw new ContextNestError(
        `Remote nest "${target.alias}" does not expose context_embed — its search index is managed by the nest. Nothing was embedded.`,
        "NOT_IMPLEMENTED",
      );
    }
    return conn.run<T>("context_embed", input);
  });
}

const isNotFound = (err: unknown) => err instanceof ContextNestError && err.code === "DOCUMENT_NOT_FOUND";

/**
 * Run `op` on an existing document by the id `documentId` derived from what
 * the user typed, so a flat-layout nest finds a root-level node. A nest that
 * does not resolve a bare id under nodes/ itself (an engine before #183,
 * contextnest-community) refuses a structured node named without the prefix,
 * so a bare id it can't find is retried once as normalizeDocumentId roots it.
 * Writes retry too: a nest raises DOCUMENT_NOT_FOUND while resolving the id,
 * before it changes anything, so the first attempt wrote nothing.
 */
async function runOnDocument<T>(
  conn: RemoteNestConnection,
  op: string,
  id: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await conn.run<T>(op, { id, ...input });
  } catch (err) {
    const rooted = normalizeDocumentId(id);
    if (rooted === id || !isNotFound(err)) throw err;
    // Missing there too: report the id the user typed, not the guess.
    return conn.run<T>(op, { id: rooted, ...input }).catch((retryErr) => {
      throw isNotFound(retryErr) ? err : retryErr;
    });
  }
}

/**
 * A body as `update --body-file` takes it back: writes store `\n<body>\n`, so
 * drop that one leading and trailing newline or every round trip adds two.
 */
export function bodyOnly(body: string): string {
  return body.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

export async function remoteRead(
  target: RemoteTarget,
  path: string,
  opts: { raw?: boolean; html?: boolean; body?: boolean },
): Promise<void> {
  if (opts.html) {
    throw new ContextNestError(
      `--html is not supported against a remote nest yet — use \`ctx read ${path} --raw\` or run against a local vault.`,
      "NOT_IMPLEMENTED",
    );
  }
  await withRemote(target, async (conn) => {
    const doc = await runOnDocument<{
      id: string;
      frontmatter: Record<string, any>;
      body: string;
      raw?: string;
    }>(conn, "context_get", documentId(path), { include_raw: Boolean(opts.raw) });

    if (opts.raw) {
      // A nest that returns no `raw` (contextnest-community's context_get has
      // no include_raw) used to print nothing here — and the plugin's
      // sweep-check reads every candidate this way, so it found nothing on a
      // remote nest. Rebuild the file from what did come back.
      console.log(doc.raw ?? serializeDocument({ id: doc.id, frontmatter: doc.frontmatter, body: doc.body } as ContextNode));
      return;
    }
    if (opts.body) {
      console.log(bodyOnly(doc.body));
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

// ─── Pull (read side) ───────────────────────────────────────────────────────

/**
 * How many nodes one listing may return while looking for a recipe. Explicit
 * because a Community-hosted nest caps a listing with no `limit` at 50.
 */
const RECIPE_LIST_LIMIT = 10_000;

/**
 * Fetch a recipe and every node it names, over one connection, for `ctx pull`.
 *
 * The recipe is found by slug (`recipe-<id>`) anywhere in the nest. Each
 * source's version is the one its body is: a governed nest serves the
 * approved version, so `approved_version` wins over the newest one.
 */
export async function remoteFetchRecipe(target: RemoteTarget, recipeId: string): Promise<FetchedRecipe> {
  return withRemote(target, async (conn, nestId) => {
    const tools = await conn.toolNames();
    const slug = `recipe-${recipeId}`;
    const listed = await conn.run<{ documents: NodeSummary[] }>("context_list", { limit: RECIPE_LIST_LIMIT });
    const hits = listed.documents.filter((d) => d.id === `nodes/${slug}` || d.id.endsWith(`/${slug}`));
    if (hits.length === 0) {
      throw new ContextNestError(
        `No recipe "${recipeId}" in ${target.alias} — expected a node whose slug is ${slug}.` +
          (listed.documents.length >= RECIPE_LIST_LIMIT ? ` (only the first ${RECIPE_LIST_LIMIT} nodes were searched)` : ""),
        "DOCUMENT_NOT_FOUND",
      );
    }
    if (hits.length > 1) {
      throw new ContextNestError(
        `Recipe "${recipeId}" is ambiguous in ${target.alias}: ${hits.map((h) => h.id).join(", ")}.`,
        "VALIDATION_FAILED",
      );
    }

    const fetchNode = async (id: string): Promise<SourceNode> => {
      const doc = await conn.run<{ id: string; frontmatter: Record<string, any>; body: string }>("context_get", { id });
      let version: number | null = null;
      if (tools.has("context_versions")) {
        const v = await conn.run<{ approved_version?: number | null; versions?: Array<{ version: number }> }>(
          "context_versions",
          { id },
        );
        const newest = (v.versions ?? []).reduce<number | null>(
          (max, e) => (max === null || e.version > max ? e.version : max),
          null,
        );
        version = v.approved_version ?? newest;
      }
      return {
        id: doc.id ?? id,
        title: doc.frontmatter.title,
        ...(doc.frontmatter.description ? { description: doc.frontmatter.description } : {}),
        ...(doc.frontmatter.type ? { type: doc.frontmatter.type } : {}),
        ...(doc.frontmatter.tags ? { tags: doc.frontmatter.tags } : {}),
        body: doc.body ?? "",
        version,
      };
    };

    const recipe = await fetchNode(hits[0].id);
    const manifest = parseRecipeManifest(recipe.body);
    const sources = new Map<string, SourceNode>();
    for (const id of manifestSources(manifest)) sources.set(id, await fetchNode(id));
    return { namespace: nestId ?? target.alias, recipe, manifest, sources };
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
    const out = await runOnDocument<{
      id: string;
      keyframe_interval?: number;
      approved_version?: number | null;
      versions: Array<Record<string, unknown>>;
    }>(conn, "context_versions", documentId(path), opts.diff ? { include_diff: true } : {});

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
      content: opts.body ? `\n${opts.body}\n` : await remoteTemplateBody(conn, id, title),
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

    let created: { id: string; version: number };
    try {
      created = await conn.run<{ id: string; version: number }>("context_create", input);
    } catch (err) {
      // A gated nest accepted the write but holds it for a reviewer; that is
      // not a failure, so report it and exit 0 like `ctx push --no-wait`.
      if (!(err instanceof ContextNestError && err.code === "PENDING_CONFIRMATION")) throw err;
      console.log(chalk.yellow(err.message));
      console.error(chalk.dim(`Held for a reviewer on "${target.alias}" — ${id} does not exist until confirmed.`));
      return;
    }
    console.log(chalk.green(`Created and published ${created.id}.md (remote: ${target.alias})`));
    console.log(`  Version: ${created.version}`);
  });
}

/**
 * The body a bodiless `ctx add` starts from on a remote nest: the folder's
 * template (§11.1), same as the local branch. A nest that does not advertise
 * `context_structure` (it predates structure rules) gets the plain heading.
 */
async function remoteTemplateBody(conn: RemoteNestConnection, id: string, title: string): Promise<string> {
  const heading = `\n# ${title}\n\n`;
  if (!(await conn.toolNames()).has("context_structure")) return heading;
  const out = await conn.run<StructureOutput>("context_structure", { folder: folderFromId(id) });
  return out.resolved?.template_body ? `\n${out.resolved.template_body}` : heading;
}

/** `ctx structure` against a remote nest — the same op, the same output. */
export async function remoteStructure(
  target: RemoteTarget,
  opts: { folder?: string; report?: boolean; json?: boolean },
): Promise<void> {
  await withRemote(target, async (conn) => {
    const out = await conn.run<StructureOutput>("context_structure", {
      ...(opts.folder !== undefined ? { folder: opts.folder } : {}),
      ...(opts.report ? { report: true } : {}),
    });
    printStructure(out, opts);
  });
}

export async function remoteUpdate(
  target: RemoteTarget,
  path: string,
  opts: {
    title?: string;
    tags?: string;
    status?: string;
    body?: string;
    assignee?: string;
    due?: string;
    priority?: string;
    parent?: string;
  },
): Promise<void> {
  const fields = taskFieldArgs(opts);
  // A rename stays refused: Community's context_update reads `title` as the
  // node SELECTOR, so sending it next to `id` would be silently ignored.
  if (opts.title !== undefined) {
    throw new ContextNestError(
      "--title is not supported against a remote nest yet (the nest reads `title` as a selector, not a rename) — rename it in the app.",
      "NOT_IMPLEMENTED",
    );
  }
  if (
    opts.body === undefined &&
    opts.tags === undefined &&
    opts.status === undefined &&
    !hasTaskFieldArgs(fields)
  ) {
    throw new ContextNestError(
      "Nothing to update — pass --body, --tags, --status, --assignee, --due, --priority or --parent.",
      "VALIDATION_FAILED",
    );
  }
  await confirmRemoteWrite(
    target,
    `Update ${documentId(path)} on remote nest "${target.alias}"? The previous content stays recoverable from its version history.`,
  );
  await withRemote(target, async (conn) => {
    if (hasTaskFieldArgs(fields)) await requireTaskSupport(conn, target.alias);
    // Same fields the local branch sends; tags REPLACE, as locally.
    const updated = await runOnDocument<{ id: string; version: number; status?: string; [k: string]: unknown }>(
      conn,
      "context_update",
      documentId(path),
      {
        ...(opts.body !== undefined ? { content: `\n${opts.body}\n` } : {}),
        ...(opts.tags !== undefined ? { tags: parseTagsOption(opts.tags) } : {}),
        ...(opts.status !== undefined ? { status: normalizeStatus(opts.status) } : {}),
        // Task fields: the nest validates them (roster, date, priority, parent).
        ...fields,
      },
    );
    // The nest's stewardship decides whether the edit published, so report
    // the status it came back with rather than assuming "published".
    console.log(chalk.green(`Updated ${updated.id} (remote: ${target.alias})`));
    console.log(`  Version: ${updated.version}`);
    if (updated.status) console.log(`  Status: ${updated.status}`);
    for (const k of TASK_FIELD_FLAGS) {
      // The nest omits unset fields from its reply, so a cleared field reads
      // back as absent; only a field sent as null may be reported cleared.
      const shown = fields[k] === null ? "(cleared)" : String(updated[k] ?? "(not returned by the nest)");
      if (k in fields) console.log(`  ${k[0].toUpperCase()}${k.slice(1)}: ${shown}`);
    }
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
  const id = documentId(path);
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
      const doc = await runOnDocument<{ frontmatter: { title?: string } }>(conn, "context_get", id);
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
    const out = await runOnDocument<{ id: string; version: number; checkpoint: number }>(
      conn,
      "context_publish",
      id,
    );
    console.log(chalk.green(`Published ${out.id} (remote: ${target.alias})`));
    console.log(`  Version: ${out.version}`);
    console.log(`  Checkpoint: ${out.checkpoint}`);
  });
}

/** One logged interaction, as context_task_log returns it. */
interface TaskLogEntry {
  id: string;
  actor: string;
  status?: string;
  note: string;
  key?: { label?: string; prefix?: string; scoped: boolean };
  client?: { agent?: string };
  at: string;
}

/**
 * `ctx task log <path> --note "…" [--status working|done|blocked] [--claim]` —
 * register what was done on a task (Community `context_task_log`). The server
 * attributes it to the key's owner, plus the key itself and `agent`.
 */
export async function remoteTaskLog(
  target: RemoteTarget,
  path: string,
  opts: { note: string; status?: string; claim?: boolean; agent?: string; json?: boolean },
): Promise<void> {
  const id = documentId(path);
  await confirmRemoteWrite(target, `Log on ${id} on remote nest "${target.alias}"?`);
  await withRemote(target, async (conn) => {
    await requireTaskSupport(conn, target.alias);
    const agent = (opts.agent ?? process.env.CONTEXTNEST_AGENT)?.trim();
    const out = await runOnDocument<{
      id: string;
      entry: TaskLogEntry;
      claim?: "assigned" | "already_yours" | "assigned_to_other";
      assignee?: string;
    }>(conn, "context_task_log", id, {
      note: opts.note,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.claim ? { claim: true } : {}),
      ...(agent ? { client: { agent } } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    const e = out.entry;
    const key = e.key ? ` (key ${e.key.label || e.key.prefix})` : "";
    console.log(chalk.green(`Logged on ${out.id} (remote: ${target.alias})`));
    console.log(`  ${e.client?.agent ?? "ctx"}${key} on behalf of ${e.actor}${e.status ? ` · ${e.status}` : ""}`);
    console.log(`  ${e.note}`);
    if (out.claim === "assigned") console.log(chalk.cyan(`  Assigned to you (${out.assignee}).`));
    if (out.claim === "assigned_to_other") {
      console.log(chalk.yellow(`  Not claimed — already assigned to ${out.assignee}.`));
    }
  });
}

export async function remoteDelete(target: RemoteTarget, path: string): Promise<void> {
  await confirmRemoteWrite(
    target,
    `Delete ${documentId(path)} and its version history from remote nest "${target.alias}"? This cannot be undone.`,
    { destructive: true },
  );
  await withRemote(target, async (conn) => {
    const out = await runOnDocument<{ id: string; deleted: true }>(conn, "context_delete", documentId(path));
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
    `Move ${documentId(path)} to folder "${folder}" on remote nest "${target.alias}"? Its id changes; history and links follow.`,
  );
  await withRemote(target, async (conn) => {
    const out = await runOnDocument<{ id: string; previous_id: string }>(conn, "context_move", documentId(path), { folder });
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
    vaults.map(async (v): Promise<{ nests: IndexedNest[] | null; note?: string }> => {
      const spec = registry.remotes?.[v.alias];
      if (v.kind !== "remote" || spec?.transport !== "http") return { nests: null };
      try {
        // An unreachable server costs one probe timeout, then is skipped for
        // NEST_PROBE_BACKOFF_MS (serverNests remembers the failure).
        return {
          nests: await serverNests(v.alias, {
            ...spec,
            timeout_ms: Math.min(spec.timeout_ms ?? LIST_PROBE_TIMEOUT_MS, LIST_PROBE_TIMEOUT_MS),
          }),
        };
      } catch (err) {
        // Never drop nests silently: show the last known list, or say why there is none.
        const stale = readNestCache(v.alias, nestCacheUrl(spec))?.nests ?? null;
        const why =
          err instanceof ContextNestError && err.code === "REMOTE_AUTH_FAILED"
            ? "server refused the key — `ctx login <server>`"
            : "server didn't answer";
        return { nests: stale, note: `${why}; ${stale ? "nest list may be out of date" : "nests not listed — try again shortly"}` };
      }
    }),
  );
  const rows: VaultRow[] = [];
  vaults.forEach((v, i) => {
    const { nests, note } = probes[i];
    const withNote = (text: string | undefined) => (note ? [text, `(${note})`].filter(Boolean).join(" ") : text);
    if (!nests) {
      rows.push(note ? { ...v, description: withNote(v.description) } : v);
      return;
    }
    rows.push({
      ...v,
      description: withNote(v.description || `All ${nests.length} nest(s) on this server — reads span every nest`),
    });
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
