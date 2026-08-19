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

import chalk from "chalk";
import {
  ContextNestError,
  connectRemoteNest,
  normalizeDocumentId,
  normalizeStatus,
  resolveNest,
} from "@promptowl/contextnest-engine";
import type { RemoteNestConnection, RemoteNestSpec } from "@promptowl/contextnest-engine";
import { confirmOrExit, isDryRun } from "./safety.js";
import {
  listJsonEntry,
  queryJsonPayload,
  searchJsonEntry,
  titleFromId,
  parseTagsOption,
} from "./doc-views.js";

export interface RemoteTarget {
  alias: string;
  spec: RemoteNestSpec;
}

/**
 * Returns the remote target when vault resolution lands on a `remotes:` entry,
 * or null when it resolves locally. Remote-capable commands call this first;
 * local-only commands keep calling resolveVaultPath(), which throws a clear
 * error for remote aliases.
 */
export function remoteTarget(vaultAlias: string | undefined): RemoteTarget | null {
  const nest = resolveNest({ vaultAlias, cwd: process.cwd() });
  return nest.kind === "remote" ? { alias: nest.alias, spec: nest.remote } : null;
}

/** Connect, run, and always close — the standard remote command wrapper. */
async function withRemote<T>(
  target: RemoteTarget,
  fn: (conn: RemoteNestConnection) => Promise<T>,
): Promise<T> {
  const conn = await connectRemoteNest(target.alias, target.spec);
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
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
    const docs = out.documents;

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
      console.log(`  ${chalk.cyan(d.id)} [${d.type || "document"}] ${d.status || "draft"}`);
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

    const sourceNodes = out.source_nodes ?? [];
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
      console.log(`  ${chalk.cyan(doc.id)}: ${doc.title}`);
    }
    if (sourceNodes.length > 0) {
      console.log(chalk.bold("\nSource Nodes (hydration order):"));
      for (const doc of sourceNodes) {
        console.log(`  ${chalk.magenta(doc.id)}: ${doc.title}`);
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
    const out = await conn.run<{ results: NodeSummary[] }>("context_search", {
      query,
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    if (opts.json) {
      // Field selection shared with the local branch (doc-views.ts).
      console.log(JSON.stringify(out.results.map(searchJsonEntry), null, 2));
      return;
    }
    if (out.results.length === 0) {
      console.log(chalk.yellow("No results found."));
      return;
    }
    console.log(chalk.bold(`${out.results.length} result(s):\n`));
    for (const doc of out.results) {
      console.log(`  ${chalk.cyan(doc.id)}: ${doc.title}`);
    }
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
      console.log(doc.raw ?? "");
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
      keyframe_interval: number;
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
      const published = entry.published_at ? chalk.green(" published") : chalk.yellow(" draft");
      console.log(`  v${entry.version}${keyframe}${published}`);
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
  // The catalog's context_update covers content replacement (and tag ADDs);
  // title/status/tags-replace semantics differ from the local command, so
  // refuse them loudly instead of silently doing something different.
  if (opts.title !== undefined || opts.status !== undefined || opts.tags !== undefined) {
    throw new ContextNestError(
      "Only --body updates are supported against a remote nest for now (title/status/tags need the governance surface).",
      "NOT_IMPLEMENTED",
    );
  }
  if (opts.body === undefined) {
    throw new ContextNestError("Nothing to update — pass --body.", "VALIDATION_FAILED");
  }
  await confirmRemoteWrite(
    target,
    `Rewrite ${normalizeDocumentId(path)} on remote nest "${target.alias}"? The previous content stays recoverable from its version history.`,
  );
  await withRemote(target, async (conn) => {
    const updated = await conn.run<{ id: string; version: number }>("context_update", {
      id: normalizeDocumentId(path),
      content: `\n${opts.body}\n`,
    });
    console.log(chalk.green(`Updated and published ${updated.id} (remote: ${target.alias})`));
    console.log(`  Version: ${updated.version}`);
  });
}

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
  if (opts.message !== undefined) {
    throw new ContextNestError(
      "--message is not supported against a remote nest yet (the catalog's publish operation takes no version note).",
      "NOT_IMPLEMENTED",
    );
  }
  const id = normalizeDocumentId(path);
  // Probe capabilities on a connection of its own: confirmRemoteWrite exits the
  // process on a decline, which would skip the close() in withRemote's finally.
  const tools = await withRemote(target, (conn) => conn.toolNames());

  if (!tools.has("context_publish")) {
    // A governed nest has no direct publish — that would bypass its review
    // plane. A node goes context_submit_review → a steward's context_approve,
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
      const doc = await conn.run<{ frontmatter: { title: string } }>("context_get", { id });
      await conn.run("context_submit_review", { title: doc.frontmatter.title });
      console.log(chalk.green(`Submitted ${id} for steward review (remote: ${target.alias})`));
      console.log(
        chalk.yellow(
          "  NOT published — this nest publishes through review. The node is not live until a steward approves it.",
        ),
      );
    });
    return;
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
