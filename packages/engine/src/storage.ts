/**
 * File system abstraction for vault operations.
 * Supports both structured and Obsidian-compatible layouts (§1.1).
 */

import { readFile, writeFile, mkdir, open, stat, unlink, rm, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import fg from "fast-glob";
import yaml from "js-yaml";
import { parseDocument } from "./parser.js";
import { parseConfig } from "./config.js";
import {
  detectDrift,
  verifyDocumentChain,
  verifyCheckpointChain,
} from "./integrity.js";
import { generateContextYaml } from "./index-generator.js";
import { generateIndexMd } from "./index-md-generator.js";
import { generateAgentConfigs, mergeAgentConfig } from "./agent-configs.js";
import { mapInBatches } from "./concurrency.js";
import type {
  ContextNode,
  NestConfig,
  DocumentHistory,
  VersionEntry,
  CheckpointHistory,
  Pack,
  ContextYaml,
  PendingChange,
  VerificationReport,
} from "./types.js";
import {
  ContextNestError,
  CorruptHistoryError,
  DocumentNotFoundError,
  VersionArtifactExistsError,
} from "./errors.js";
import {
  packSchema,
  documentHistorySchema,
  checkpointHistorySchema,
} from "./schemas.js";

/** Sentinel suggestion_id used before a drift has been staged into `_suggestions/`. */
export const UNSTAGED_DRIFT_SENTINEL = "unstaged-drift";


/**
 * Normalize a user-supplied document path/slug into a canonical document id.
 *
 * Single source of truth shared by every client (CLI, MCP) so a bare slug
 * resolves to the same place no matter which surface created it:
 *   - strips a trailing `.md` extension,
 *   - strips leading slashes,
 *   - defaults a bare slug (no `/`) into `nodes/` so it lands where discovery
 *     scans; explicit folder paths (`nodes/x`, `sources/y`) are respected as-is.
 *   - rejects `..` segments — callers always join the id against the vault root,
 *     so a traversal sequence would escape the vault (arbitrary read/write/delete
 *     via a manipulated CLI/MCP path).
 *
 * @example normalizeDocumentId("my-doc")        // "nodes/my-doc"
 * @example normalizeDocumentId("sources/cfg")   // "sources/cfg"
 * @example normalizeDocumentId("/nodes/x.md")   // "nodes/x"
 * @example normalizeDocumentId("../../etc/x")   // throws — path traversal
 */
export function normalizeDocumentId(raw: string): string {
  const trimmed = raw.replace(/\.md$/, "").replace(/^\/+/, "");
  assertSafeDocumentId(trimmed);
  return trimmed.includes("/") ? trimmed : `nodes/${trimmed}`;
}

/**
 * Reject an id that would escape the vault root. Callers join ids against the
 * root verbatim, so every id arriving from outside must clear this.
 *
 * Split out of `normalizeDocumentId` because that also re-roots a bare slug
 * under `nodes/` — wrong for an id a flat-layout vault already resolved, which
 * needs the traversal check WITHOUT the rewrite.
 */
export function assertSafeDocumentId(raw: string): void {
  if (raw.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new ContextNestError(
      `Invalid document id "${raw}": path traversal ("..") is not allowed.`,
      "INVALID_DOCUMENT_ID",
    );
  }
}

/** Options for `NestStorage.readDocument`. */
export interface ReadDocumentOptions {
  /**
   * When true, recompute the body hash and compare against the stored
   * frontmatter checksum (bridge-function-spec Story 3.1, Story 2.1).
   *
   * On drift:
   *   - If a last-approved keyframe exists for the document, the returned
   *     `ContextNode` contains the APPROVED content — never the live
   *     drifted bytes (hootie-inbox-spec §4.2: "document remains at last
   *     approved state for injection purposes").
   *   - A `pendingChange` field is attached pointing at the drifted hash.
   *     If no staged suggestion exists yet, `suggestion_id` is
   *     `UNSTAGED_DRIFT_SENTINEL`; the suggestions module will overwrite it
   *     when the drift is staged.
   *   - If no keyframe is available (legacy doc with no version history),
   *     the live bytes are returned with `pendingChange` attached so the
   *     caller is at least aware of the drift.
   *
   * Default: false (backward compatible — no behavior change for existing
   * callers that just want raw parsed bytes).
   */
  verifyChecksum?: boolean;
}

export type LayoutMode = "structured" | "obsidian";

/**
 * `rename` onto an existing target is atomic on POSIX but contended on Windows:
 * if any other handle has the destination open — a concurrent replace of the
 * same file, an antivirus scanner, the search indexer — MoveFileEx fails with
 * EPERM/EACCES/EBUSY rather than waiting. The contention is transient, so retry
 * briefly before giving up.
 *
 * ponytail: fixed backoff schedule, ~500ms total across 10 attempts. If a real
 * workload starts losing writes here, the fix is a per-path write queue, not a
 * longer sleep.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
  const MAX_ATTEMPTS = 10;

  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= MAX_ATTEMPTS - 1 || !RETRYABLE.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 250)));
    }
  }
}

export class NestStorage {
  constructor(public readonly root: string) {}

  /**
   * In-process serialization chain for the checkpoint history
   * read-modify-write. See `withCheckpointLock`.
   */
  private checkpointWriteChain: Promise<unknown> = Promise.resolve();

  /** Disambiguates concurrent `writeFileDurable` temp files. See that method. */
  private tmpWriteCounter = 0;

  /**
   * Run `fn` with exclusive access to the checkpoint history file, serializing
   * concurrent callers in this process. `createCheckpoint` reads, mutates, and
   * rewrites `context_history.yaml`; without this lock concurrent publishes
   * (e.g. `Promise.all`) each read the same base history and the last writer
   * clobbers the rest, silently dropping checkpoints.
   *
   * In-process only: this does NOT guard separate OS processes, which would
   * require file-level locking.
   */
  async withCheckpointLock<T>(fn: () => Promise<T>): Promise<T> {
    // Invoke fn with no arguments on both settle paths: `.then(fn, fn)` would
    // pass the prior critical section's rejection reason as fn's first argument.
    const run = this.checkpointWriteChain.then(
      () => fn(),
      () => fn(),
    );
    // Keep the chain alive regardless of how `run` settles so a rejected
    // critical section does not wedge every subsequent caller.
    this.checkpointWriteChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Detect layout mode. If nodes/ directory exists, structured; otherwise Obsidian.
   */
  async detectLayout(): Promise<LayoutMode> {
    try {
      const s = await stat(join(this.root, "nodes"));
      return s.isDirectory() ? "structured" : "obsidian";
    } catch {
      return "obsidian";
    }
  }

  /**
   * Discover all markdown documents in the vault.
   * Skips hidden directories (.-prefixed) and node_modules.
   *
   * By default, documents with `status: rejected` are EXCLUDED — they stay
   * on disk for audit history but never surface to retrieval (CLI / MCP /
   * community / desktop all inherit this). Callers that need the full set
   * (integrity checks, hygienist, regenerateIndex, version audit) pass
   * `{ includeRetired: true }`.
   *
   * Back-compat: `includeSuperseded` is accepted as a deprecated alias for
   * `includeRetired`. Either flag opens the filter.
   */
  async discoverDocuments(
    options: { includeRetired?: boolean; includeSuperseded?: boolean } = {},
  ): Promise<ContextNode[]> {
    const layout = await this.detectLayout();
    let patterns: string[];

    if (layout === "structured") {
      // Include root-level *.md so a node is discoverable wherever it lives,
      // not only under nodes/ or sources/. Agent-config and scaffold files at
      // the root are excluded via the ignore list below.
      patterns = ["*.md", "nodes/**/*.md", "sources/**/*.md"];
    } else {
      patterns = ["**/*.md"];
    }

    const files = await fg(patterns, {
      cwd: this.root,
      ignore: [
        "**/node_modules/**",
        "**/.versions/**",
        "**/.context/**",
        "**/INDEX.md",
        "CONTEXT.md",
        "context.yaml",
        // Agent-config / scaffold files are not knowledge nodes.
        "**/CLAUDE.md",
        "**/GEMINI.md",
        "**/AGENTS.md",
        "**/README.md",
      ],
      dot: false,
      // Skip unreadable directories rather than failing the whole crawl.
      suppressErrors: true,
    });

    const parsed = await mapInBatches(files.sort(), async (file) => {
      const filePath = join(this.root, file);
      const content = await readFile(filePath, "utf-8");
      const id = file.replace(/\.md$/, "");
      const node = parseDocument(filePath, content, id);
      // Root-level discovery (structured layout) globs *.md at the vault root so
      // a node can live anywhere. But a vault root commonly holds scaffold files
      // (CHANGELOG, CONTRIBUTING, LICENSE, SECURITY, …) that are NOT knowledge
      // nodes. Require authored frontmatter before treating a root file as a node
      // — an authored node always has frontmatter; plain scaffold markdown does
      // not. parseDocument injects a default `status` even when none was present,
      // so the scaffold signal is "no authored keys beyond that injected status".
      // (Only root-level files in structured layout: nodes/ and sources/ files
      // are always nodes, and Obsidian notes legitimately have no frontmatter.)
      const isRootLevel = !file.includes("/");
      const authoredKeys = Object.keys(node.frontmatter).filter((k) => k !== "status");
      if (layout === "structured" && isRootLevel && authoredKeys.length === 0) {
        return null;
      }
      return node;
    });
    const nodes = parsed.filter((n): n is ContextNode => n !== null);

    const includeRetired = options.includeRetired || options.includeSuperseded;
    if (includeRetired) return nodes;
    return nodes.filter((n) => n.frontmatter.status !== "rejected");
  }

  /**
   * Read a single document by its id (relative path without .md).
   *
   * Default behavior (no options): reads the live `.md` file and returns
   * the parsed node verbatim. Backward-compatible with all existing callers.
   *
   * With `verifyChecksum: true`: detects out-of-band edits per
   * bridge-function-spec Story 3.1 + Story 2.1. On drift the returned
   * node carries the last-approved canonical content (never the drifted
   * live bytes — hootie-inbox-spec §4.2) plus a `pendingChange` flag.
   */
  async readDocument(
    id: string,
    options: ReadDocumentOptions = {},
  ): Promise<ContextNode> {
    // Read the file at exactly `${id}.md`. We deliberately do NOT fall back to a
    // root-level file for a `nodes/<slug>` id: writes always target `${id}.md`,
    // so a read that silently resolved elsewhere would split a later
    // update_document into a second file and leave the original stale. Root-level
    // nodes remain discoverable via list/search; they are addressed by their own
    // (root) id, not by a normalized `nodes/` slug.
    const filePath = join(this.root, `${id}.md`);
    let liveContent: string;
    try {
      liveContent = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DocumentNotFoundError(id);
      }
      throw err;
    }

    const liveNode = parseDocument(filePath, liveContent, id);
    if (!options.verifyChecksum) {
      return liveNode;
    }

    const drift = detectDrift(liveContent, liveNode.frontmatter.checksum);
    if (!drift.drifted) {
      return liveNode;
    }

    // Drift detected. Try to serve last-approved canonical content
    // (hootie-inbox-spec §4.2). Live bytes are NEVER promoted into
    // canonical state here — that happens only via approval (step 7).
    const approved = await this.readLatestApprovedKeyframe(id);
    const pendingChange: PendingChange = {
      suggestion_id: UNSTAGED_DRIFT_SENTINEL,
      detected_at: new Date().toISOString(),
      source: "out-of-band-edit",
      proposed_hash: drift.actualHash,
    };

    if (approved) {
      const approvedNode = parseDocument(filePath, approved.content, id);
      return { ...approvedNode, pendingChange };
    }

    // No keyframe to fall back to — surface drift on the live node so the
    // caller at least knows. Engine still does not mutate the live file.
    return { ...liveNode, pendingChange };
  }

  /**
   * Compute drift for a document without touching the live file (read-only).
   * Returns `null` when the document does not exist.
   *
   * Useful for the checkpoint hook and background hygienist (step 9 / 10).
   */
  async detectDocumentDrift(
    id: string,
  ): Promise<ReturnType<typeof detectDrift> | null> {
    const filePath = join(this.root, `${id}.md`);
    let liveContent: string;
    try {
      liveContent = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    const liveNode = parseDocument(filePath, liveContent, id);
    return detectDrift(liveContent, liveNode.frontmatter.checksum);
  }

  /**
   * Regenerate derived vault files after any mutation: context.yaml,
   * per-folder INDEX.md, and agent-config files (CLAUDE.md, GEMINI.md,
   * .cursorrules, etc.).
   *
   * Single source for mcp-server, cli, and desktop. Each agent-config file
   * is merged with its existing on-disk content so user-authored sections
   * outside engine-managed blocks are preserved.
   */
  async regenerateIndex(): Promise<void> {
    // Per-folder INDEX.md must list retired docs too so stewards can find
    // them; context.yaml gets filtered to published only below.
    const docs = await this.discoverDocuments({ includeRetired: true });
    const config = await this.readConfig();
    const checkpointHistory = await this.readCheckpointHistory();
    const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
    const published = docs.filter((d) => d.frontmatter.status === "published");
    const packs = await this.readPacks();

    const contextYaml = generateContextYaml(published, config, latestCheckpoint);
    await this.writeContextYaml(contextYaml);

    const folders = new Map<string, ContextNode[]>();
    for (const doc of docs) {
      const parts = doc.id.split("/");
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push(doc);
    }

    // Distinct folders write distinct INDEX.md files, so the writes are
    // independent — batch them (an imported vault can carry hundreds).
    await mapInBatches(
      [...folders].filter(([folder]) => folder !== "."),
      async ([folder, folderDocs]) => {
        const title = folder
          .split("/")
          .pop()!
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        await this.writeIndexMd(folder, generateIndexMd(folder, title, folderDocs));
      },
    );

    const hasMcpServer = !!(config?.servers && Object.keys(config.servers).length > 0);
    const agentConfigs = generateAgentConfigs({
      config,
      contextYaml,
      packs,
      hasMcpServer,
    });

    for (const file of agentConfigs) {
      const filePath = join(this.root, file.path);
      await mkdir(dirname(filePath), { recursive: true });

      let existing: string | null = null;
      try {
        existing = await readFile(filePath, "utf-8");
      } catch {
        // file does not exist yet
      }

      const merged = mergeAgentConfig(existing, file.content);
      await writeFile(filePath, merged, "utf-8");
    }
  }

  /**
   * Full vault integrity check: document chains, checkpoint chain, and
   * live-body drift against stored frontmatter checksums.
   *
   * Single entry point used by mcp-server, cli, desktop. Detects:
   *   - content_hash_mismatch / chain_hash_mismatch in version history
   *   - cross_chain_mismatch / checkpoint_hash_mismatch in checkpoints
   *   - body_drift when live `.md` body sha256 != frontmatter.checksum
   *   - unreadable_history when a history.yaml exists but cannot be parsed
   */
  async verifyVaultIntegrity(): Promise<VerificationReport> {
    const errors: VerificationReport["errors"] = [];
    // A history we cannot parse is an unverifiable document, not a clean one —
    // report it instead of letting the crawl skip it into a silent pass.
    const allHistories = await this.findAllHistories((docId, reason) => {
      errors.push({
        type: "unreadable_history",
        document: docId,
        expected: null,
        actual: reason,
      });
    });
    const checkpointHistory = await this.readCheckpointHistory();

    for (const [docId, history] of allHistories) {
      // Pre-load keyframe bytes so the (synchronous) verifyDocumentChain
      // callback can re-hash them. Without this the keyframe content check is
      // skipped, and a tampered v{N}.md keyframe — canonical file + history.yaml
      // left intact — goes undetected. Keyframe files are small; the reads are
      // cheap, and the chain check below still works when one is missing.
      //
      // Non-keyframe entries hash their change log, which now lives in a
      // v{N}.diff file rather than inline on the entry — pre-load those too, or
      // a tampered diff file goes unchecked exactly the way a tampered keyframe
      // used to.
      const keyframeContent = new Map<number, string>();
      const diffContent = new Map<number, string>();
      for (const entry of history.versions) {
        if (entry.keyframe) {
          const content = await this.readKeyframe(docId, entry.version);
          if (content !== null) keyframeContent.set(entry.version, content);
        } else {
          const diff = await this.readDiff(docId, entry.version);
          if (diff !== null) diffContent.set(entry.version, diff);
        }
      }
      const report = verifyDocumentChain(
        docId,
        history,
        (version) => keyframeContent.get(version) ?? null,
        (version) => diffContent.get(version) ?? null,
      );
      if (!report.valid) errors.push(...report.errors);
    }

    if (checkpointHistory) {
      const report = verifyCheckpointChain(
        checkpointHistory.checkpoints,
        allHistories,
      );
      if (!report.valid) errors.push(...report.errors);
    }

    // Integrity check must verify every doc on disk, including retired ones.
    const liveDocs = await this.discoverDocuments({ includeRetired: true });
    for (const doc of liveDocs) {
      const drift = await this.detectDocumentDrift(doc.id);
      if (drift && drift.drifted) {
        errors.push({
          type: "body_drift",
          document: doc.id,
          expected: drift.storedHash,
          actual: drift.actualHash,
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Return the most recent keyframe content for a document, if any.
   * Walks the history backward looking for the last `keyframe: true` entry
   * with an extant `v{N}.md` file. Returns `null` for legacy docs with no
   * history or no keyframes on disk.
   */
  async readLatestApprovedKeyframe(
    id: string,
  ): Promise<{ version: number; content: string } | null> {
    const history = await this.readHistory(id);
    if (!history || history.versions.length === 0) return null;
    for (let i = history.versions.length - 1; i >= 0; i--) {
      const entry = history.versions[i];
      if (!entry.keyframe) continue;
      const content = await this.readKeyframe(id, entry.version);
      if (content !== null) {
        return { version: entry.version, content };
      }
    }
    return null;
  }

  /**
   * Write a document to disk.
   *
   * With `{ exclusive: true }` the write is fail-if-exists (O_EXCL) so a
   * create-and-write is atomic: two concurrent creates for the same id can't
   * both pass a separate exists-check and clobber each other (TOCTOU). The
   * loser gets DOCUMENT_ALREADY_EXISTS. Default (overwrite) is unchanged.
   */
  async writeDocument(
    id: string,
    content: string,
    options: { exclusive?: boolean } = {},
  ): Promise<void> {
    const filePath = join(this.root, `${id}.md`);
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, content, {
        encoding: "utf-8",
        ...(options.exclusive ? { flag: "wx" } : {}),
      });
    } catch (err) {
      if (options.exclusive && (err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ContextNestError(`Document "${id}" already exists`, "DOCUMENT_ALREADY_EXISTS");
      }
      throw err;
    }
  }

  /**
   * Delete a document and its version history from the vault.
   */
  async deleteDocument(id: string): Promise<void> {
    const filePath = join(this.root, `${id}.md`);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DocumentNotFoundError(id);
      }
      throw err;
    }

    // Clean up version history if it exists
    const docName = basename(id);
    const docDir = dirname(id);
    const versionsDir = join(this.root, docDir, ".versions", docName);
    try {
      await rm(versionsDir, { recursive: true });
    } catch {
      // No version history to clean up
    }
  }

  /**
   * Batch-read documents by ID. Only loads bodies for requested IDs.
   * Parallelizes reads for performance. Missing documents are silently skipped.
   */
  async readDocuments(ids: string[]): Promise<Map<string, ContextNode>> {
    const results = new Map<string, ContextNode>();
    const reads = ids.map(async (id) => {
      try {
        const doc = await this.readDocument(id);
        results.set(id, doc);
      } catch {
        // Skip missing documents (may have been deleted since index was built)
      }
    });
    await Promise.all(reads);
    return results;
  }

  /**
   * Read CONTEXT.md vault identity file (§1.2).
   */
  async readContextMd(): Promise<string | null> {
    try {
      return await readFile(join(this.root, "CONTEXT.md"), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Read .context/config.yaml (§11.1).
   */
  async readConfig(): Promise<NestConfig | null> {
    try {
      const content = await readFile(
        join(this.root, ".context", "config.yaml"),
        "utf-8",
      );
      return parseConfig(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Read context.yaml (§5).
   */
  async readContextYaml(): Promise<ContextYaml | null> {
    try {
      const content = await readFile(
        join(this.root, "context.yaml"),
        "utf-8",
      );
      return yaml.load(content) as ContextYaml;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write context.yaml.
   */
  async writeContextYaml(data: ContextYaml): Promise<void> {
    const content = "# Auto-generated. Do not edit manually.\n" + yaml.dump(data, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    await writeFile(join(this.root, "context.yaml"), content, "utf-8");
  }

  /**
   * Read document history from .versions/{docName}/history.yaml (§6.2).
   *
   * `null` means "this document has no history yet" and nothing else. A file
   * that is present but unreadable raises {@link CorruptHistoryError}.
   *
   * The distinction is load-bearing. Every write path reads this, and each one
   * treats `null` as a brand-new document; because history.yaml is rewritten
   * whole rather than appended to, a corrupt file that read as `null` was
   * silently replaced by a two-entry history on the next publish — orphaning the
   * recorded versions' keyframe/diff files and taking `reconstruct` with them.
   */
  async readHistory(docId: string): Promise<DocumentHistory | null> {
    let content: string;
    try {
      content = await readFile(this.historyPath(docId), "utf-8");
    } catch (err) {
      // Absent is the only benign case. Present-but-unreadable (EACCES, EISDIR,
      // an I/O error) must not read as a fresh document either.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CorruptHistoryError(
        docId,
        err instanceof Error ? err.message : String(err),
      );
    }

    let raw: unknown;
    try {
      raw = yaml.load(content);
    } catch (err) {
      throw new CorruptHistoryError(
        docId,
        err instanceof Error ? err.message : String(err),
      );
    }

    const result = documentHistorySchema.safeParse(raw);
    if (!result.success) {
      throw new CorruptHistoryError(
        docId,
        `failed schema validation (${result.error.issues[0]?.message ?? "unknown issue"})`,
      );
    }
    return result.data as DocumentHistory;
  }

  /**
   * Durable write for the hash-chain files: write a sibling temp file, flush it
   * to disk, then rename over the target.
   *
   * A plain `writeFile` truncates and extends in place. If the process dies (or
   * the machine loses power) after the metadata grows but before the data is
   * flushed, the file comes back zero-filled — the "null byte is not allowed in
   * input" YAMLException seen from `findAllHistories`. Reserved for
   * history.yaml / context_history.yaml: they are the integrity anchors, and a
   * torn one is unrecoverable, unlike a regenerable index.
   *
   * The temp name is unique per call. A shared `{path}.tmp` would make
   * concurrent writers to the same target collide: both open and truncate the
   * same temp file, the first rename consumes it, and the second fails ENOENT.
   * That is not hypothetical — `rebuildCheckpointHistory` deliberately writes
   * context_history.yaml outside `withCheckpointLock` (holding it would deadlock
   * against the publishes it retries around), so it can overlap a publish's
   * write. Unique temps keep the old last-write-wins semantics instead of
   * turning that overlap into a throw.
   */
  private async writeFileDurable(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${++this.tmpWriteCounter}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithRetry(tmp, path);
    } catch (err) {
      // Never leave the temp behind if the rename itself failed.
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Absolute path of a document's history.yaml. */
  private historyPath(docId: string): string {
    return join(
      this.root,
      dirname(docId),
      ".versions",
      basename(docId),
      "history.yaml",
    );
  }

  /**
   * Rewrite a document's history.yaml in full.
   *
   * Only for the paths that genuinely MUTATE existing entries — re-anchoring a
   * version, moving inline patches into files. Recording a NEW version goes
   * through {@link appendVersionEntry}, which cannot touch the bytes of the
   * entries already on disk. Prefer that: a full rewrite is only ever as correct
   * as the object handed to it, and an object built from a bad read is how a
   * corrupt history silently became a two-entry one.
   *
   * `versions` is forced last so the serialized list stays open at the end of
   * the file for appending. Anything else here is a latent break in append.
   */
  async writeHistory(docId: string, history: DocumentHistory): Promise<void> {
    const { versions, ...rest } = history;
    await mkdir(dirname(this.historyPath(docId)), { recursive: true });
    const content = yaml.dump(
      { ...rest, versions },
      { lineWidth: -1, noRefs: true },
    );
    await this.writeFileDurable(this.historyPath(docId), content);
  }

  /**
   * Record one new version by APPENDING it to history.yaml.
   *
   * The bytes of every previously recorded version are never reopened for
   * writing, so no bug in a caller — and no failed read — can drop them. That is
   * the difference between "we check before rewriting" and "there is nothing to
   * rewrite": the old full-rewrite path lost v1–v4 whenever the read that fed it
   * came back empty, and a guard on the read is only as good as the next code
   * path that forgets it.
   *
   * The file's header (`keyframe_interval` + the `versions:` key) belongs to
   * whichever caller CREATES the file, and it is written in the same operation
   * as that caller's own entry. Deciding on the header from an observed size
   * would be a check-then-act race: concurrent first-time appends each see an
   * empty file and each prepend a header, leaving two `versions:` keys and an
   * unparseable history (measured: ~70% of documents corrupted under load).
   * Exclusive create is what makes it exact — the OS picks one winner, and it
   * holds across processes, which an in-process lock would not.
   *
   * Every write goes out under O_APPEND and is fsynced. `writeHistory` keeps
   * `versions` last so the list stays open at EOF for these appends.
   */
  async appendVersionEntry(
    docId: string,
    entry: VersionEntry,
    keyframeInterval: number,
  ): Promise<void> {
    const path = this.historyPath(docId);
    await mkdir(dirname(path), { recursive: true });

    // One list item, indented to sit under `versions:`. Indenting a whole YAML
    // document by a fixed amount keeps it valid, including multi-line scalars.
    const block = yaml
      .dump([entry], { lineWidth: -1, noRefs: true })
      .split("\n")
      .map((line) => (line.length > 0 ? `  ${line}` : line))
      .join("\n");
    const header = `keyframe_interval: ${keyframeInterval}\nversions:\n`;

    // Create-and-write in one shot. Exactly one caller can win `wx`, so exactly
    // one header is ever written — and it lands together with its entry, so the
    // file is never left as a header with no versions under it.
    try {
      const created = await open(path, "wx");
      try {
        await created.write(header + block);
        await created.sync();
      } finally {
        await created.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const handle = await open(path, "a");
    try {
      // The file exists. A zero-length one normally means an external
      // truncation, so write the header rather than append into a headerless
      // file.
      //
      // Known residual window: the winner's `wx` open creates a 0-byte file and
      // resolves BEFORE its write lands, so a loser that gets EEXIST, reopens
      // and stats inside that gap would also see 0 and also write a header,
      // giving two `versions:` keys. Not closed here because it needs the loser
      // to complete three threadpool round-trips inside the winner's single
      // queued write, and it did not occur in 60 rounds of 32-way contention on
      // a single new file (nor 1200 docs of 3-way). If it ever does, the result
      // is an unparseable history — loud (CorruptHistoryError), not silent — and
      // the fix is to have the loser re-stat with a bounded wait instead of
      // trusting the first observation.
      const { size } = await handle.stat();
      await handle.write(size === 0 ? header + block : block);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Read a keyframe version file.
   */
  async readKeyframe(docId: string, version: number): Promise<string | null> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const keyframePath = join(
      this.root,
      docDir,
      ".versions",
      docName,
      `v${version}.md`,
    );
    try {
      return await readFile(keyframePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write a version artifact (`v{N}.md` / `v{N}.diff`).
   *
   * Sealed versions are immutable: the artifact's bytes are hashed into
   * `content_hash` and chained, so overwriting one destroys the only copy of
   * that version's content AND silently breaks the chain. The default refuses,
   * via an exclusive create rather than an exists-check, so two writers cannot
   * race past the guard. Repair paths that must genuinely re-anchor an artifact
   * opt in with `overwrite`.
   */
  private async writeVersionArtifact(
    docId: string,
    version: number,
    fileName: string,
    content: string,
    overwrite: boolean,
  ): Promise<void> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const dir = join(this.root, docDir, ".versions", docName);
    await mkdir(dir, { recursive: true });
    const path = join(dir, fileName);

    if (overwrite) {
      await this.writeFileDurable(path, content);
      return;
    }

    let handle;
    try {
      handle = await open(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new VersionArtifactExistsError(docId, version, fileName);
      }
      throw err;
    }
    try {
      await handle.writeFile(content, "utf-8");
      // Flush before the history entry that hashes this content is recorded.
      // history.yaml is fsynced; without this the artifact it points at could
      // still be in the page cache, so a power loss could leave a durable entry
      // referencing truncated or missing content.
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Write a keyframe version file. Refuses to overwrite a sealed one unless
   * `options.overwrite` is set — see {@link writeVersionArtifact}.
   */
  async writeKeyframe(
    docId: string,
    version: number,
    content: string,
    options: { overwrite?: boolean } = {},
  ): Promise<void> {
    await this.writeVersionArtifact(
      docId,
      version,
      `v${version}.md`,
      content,
      options.overwrite ?? false,
    );
  }

  /**
   * Read the change log for a non-keyframe version — the unified diff taking
   * v{version-1} to v{version}, stored beside the keyframes as v{version}.diff.
   *
   * Returns null when there is no diff file. Histories written before diffs
   * were externalized carry the patch inline on the version entry instead, so
   * callers fall back to `entry.diff` (see VersionManager.reconstructVersion) —
   * that fallback is what keeps pre-existing nests readable without migration.
   */
  async readDiff(docId: string, version: number): Promise<string | null> {
    const docName = basename(docId);
    const docDir = dirname(docId);
    const diffPath = join(
      this.root,
      docDir,
      ".versions",
      docName,
      `v${version}.diff`,
    );
    try {
      return await readFile(diffPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write the change log for a non-keyframe version.
   *
   * Content is the unified diff exactly as produced by `createPatch` — hunk
   * headers included — so the file is readable on its own and applies with
   * standard patch tooling.
   *
   * Refuses to overwrite a sealed change log unless `options.overwrite` is set
   * — see {@link writeVersionArtifact}.
   */
  async writeDiff(
    docId: string,
    version: number,
    diff: string,
    options: { overwrite?: boolean } = {},
  ): Promise<void> {
    await this.writeVersionArtifact(
      docId,
      version,
      `v${version}.diff`,
      diff,
      options.overwrite ?? false,
    );
  }

  /**
   * Path layout for staged suggestions (bridge-function-spec Story 3.1):
   *
   *   {docDir}/_suggestions/{docName}/{suggestionId}.patch
   *   {docDir}/_suggestions/{docName}/{suggestionId}.meta.yaml
   *
   * Mirrors the `.versions/` layout for consistency.
   */
  private suggestionDir(docId: string): string {
    const docName = basename(docId);
    const docDir = dirname(docId);
    return join(this.root, docDir, "_suggestions", docName);
  }

  /** Write a unified-diff patch for a staged suggestion. */
  async writeSuggestionPatch(
    docId: string,
    suggestionId: string,
    patch: string,
  ): Promise<string> {
    const dir = this.suggestionDir(docId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${suggestionId}.patch`);
    await writeFile(path, patch, "utf-8");
    return path;
  }

  /** Write the YAML meta record for a staged suggestion. */
  async writeSuggestionMeta(
    docId: string,
    suggestionId: string,
    meta: unknown,
  ): Promise<string> {
    const dir = this.suggestionDir(docId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${suggestionId}.meta.yaml`);
    const content = yaml.dump(meta, { lineWidth: -1, noRefs: true });
    await writeFile(path, content, "utf-8");
    return path;
  }

  /** Read a staged suggestion's patch text, or null when absent. */
  async readSuggestionPatch(
    docId: string,
    suggestionId: string,
  ): Promise<string | null> {
    try {
      return await readFile(
        join(this.suggestionDir(docId), `${suggestionId}.patch`),
        "utf-8",
      );
    } catch {
      return null;
    }
  }

  /** Read a staged suggestion's parsed meta, or null when absent. */
  async readSuggestionMeta(
    docId: string,
    suggestionId: string,
  ): Promise<unknown | null> {
    try {
      const raw = await readFile(
        join(this.suggestionDir(docId), `${suggestionId}.meta.yaml`),
        "utf-8",
      );
      return yaml.load(raw);
    } catch {
      return null;
    }
  }

  /** List all suggestion IDs staged for a document, sorted by file name. */
  async listSuggestionIds(docId: string): Promise<string[]> {
    const dir = this.suggestionDir(docId);
    const files = await fg("*.meta.yaml", { cwd: dir, dot: false }).catch(
      () => [] as string[],
    );
    return files
      .map((f) => f.replace(/\.meta\.yaml$/, ""))
      .sort();
  }

  /**
   * Move a staged suggestion's patch + meta files into the per-doc archive
   * (hootie-inbox-spec §7: governance history permanently retained).
   *
   * Layout: `{docDir}/_suggestions/{docName}/_archive/{kind}/{id}.{patch|meta.yaml}`.
   * Returns the absolute archive directory.
   */
  async archiveSuggestion(
    docId: string,
    suggestionId: string,
    kind: "approved" | "rejected",
  ): Promise<string> {
    const srcDir = this.suggestionDir(docId);
    const destDir = join(srcDir, "_archive", kind);
    await mkdir(destDir, { recursive: true });
    const patchSrc = join(srcDir, `${suggestionId}.patch`);
    const metaSrc = join(srcDir, `${suggestionId}.meta.yaml`);
    const patchDest = join(destDir, `${suggestionId}.patch`);
    const metaDest = join(destDir, `${suggestionId}.meta.yaml`);
    await rename(patchSrc, patchDest);
    await rename(metaSrc, metaDest);
    return destDir;
  }

  /**
   * Read checkpoint history from .versions/context_history.yaml (§7.2).
   */
  async readCheckpointHistory(): Promise<CheckpointHistory | null> {
    try {
      const content = await readFile(
        join(this.root, ".versions", "context_history.yaml"),
        "utf-8",
      );
      const raw = yaml.load(content);
      const result = checkpointHistorySchema.safeParse(raw);
      return result.success ? (result.data as CheckpointHistory) : null;
    } catch {
      return null;
    }
  }

  /**
   * Write checkpoint history.
   */
  async writeCheckpointHistory(history: CheckpointHistory): Promise<void> {
    const dir = join(this.root, ".versions");
    await mkdir(dir, { recursive: true });
    const content =
      "# Auto-generated. Do not edit manually.\n" +
      yaml.dump(history, { lineWidth: -1, noRefs: true });
    await this.writeFileDurable(join(dir, "context_history.yaml"), content);
  }

  /**
   * Path to the chain-events log file (zone-classification-rbac-spec §6,
   * hootie-inbox-spec §8). Lives alongside the checkpoint history.
   */
  private chainEventLogPath(): string {
    return join(this.root, ".versions", "chain_events.yaml");
  }

  /**
   * Read the raw chain-event log. Returns an empty array if the file is
   * absent or unreadable. Callers should validate entries via
   * `hashChainEventSchema` before consuming — this method does not
   * schema-check, to stay symmetric with the other low-level readers.
   */
  async readChainEventLog(): Promise<unknown[]> {
    try {
      const raw = await readFile(this.chainEventLogPath(), "utf-8");
      const parsed = yaml.load(raw);
      if (Array.isArray(parsed)) return parsed;
      // Tolerate documents that wrap the list under an `events:` key.
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).events)) {
        return (parsed as { events: unknown[] }).events;
      }
      return [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * Append a single chain event to the log. Atomic at the YAML-document
   * level (write a fresh full file each time). Caller is responsible for
   * ensuring the event is schema-valid.
   */
  async appendChainEvent(event: unknown): Promise<void> {
    const existing = await this.readChainEventLog();
    existing.push(event);
    const dir = join(this.root, ".versions");
    await mkdir(dir, { recursive: true });
    const content =
      "# Hash chain events — append only. Do not edit manually.\n" +
      yaml.dump(existing, { lineWidth: -1, noRefs: true });
    await writeFile(this.chainEventLogPath(), content, "utf-8");
  }

  /**
   * Read all packs from packs/ directory (§3).
   */
  async readPacks(): Promise<Pack[]> {
    const packFiles = await fg("packs/**/*.yml", {
      cwd: this.root,
      dot: false,
      // Skip unreadable directories rather than failing the whole crawl.
      suppressErrors: true,
    });
    const packs: Pack[] = [];
    for (const file of packFiles.sort()) {
      const content = await readFile(join(this.root, file), "utf-8");
      const raw = yaml.load(content);
      const result = packSchema.safeParse(raw);
      if (result.success) {
        packs.push(result.data as Pack);
      }
    }
    return packs;
  }

  /**
   * Write an INDEX.md file.
   */
  async writeIndexMd(folder: string, content: string): Promise<void> {
    const indexPath = join(this.root, folder, "INDEX.md");
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, content, "utf-8");
  }

  /**
   * Write CONTEXT.md.
   */
  async writeContextMd(content: string): Promise<void> {
    await writeFile(join(this.root, "CONTEXT.md"), content, "utf-8");
  }

  /**
   * Write .context/config.yaml.
   */
  async writeConfig(config: NestConfig): Promise<void> {
    const configDir = join(this.root, ".context");
    await mkdir(configDir, { recursive: true });
    const content = yaml.dump(config, { lineWidth: -1, noRefs: true });
    await writeFile(join(configDir, "config.yaml"), content, "utf-8");
  }

  /**
   * Find all document history files across the nest.
   * Used for checkpoint rebuild (§7.3).
   *
   * A history file that cannot be parsed (truncated / null-byte-padded by an
   * interrupted write, hand-edited into invalid YAML, failing the schema) is
   * SKIPPED rather than thrown from: one corrupt file used to abort the whole
   * crawl, taking `ctx verify`, `ctx publish`'s checkpoint seal and the §7.3
   * rebuild down with it. Skipping alone would be a silent green though —
   * `verifyCheckpointChain` treats a missing history as "nothing to check" — so
   * callers that verify pass `onUnreadable` and report the file as an
   * `unreadable_history` integrity error.
   */
  async findAllHistories(
    onUnreadable?: (docId: string, reason: string) => void,
  ): Promise<Map<string, DocumentHistory>> {
    const historyFiles = await fg("**/.versions/*/history.yaml", {
      cwd: this.root,
      dot: true,
      // Skip unreadable directories instead of crashing checkpoint rebuild
      // on a single permission-denied dir under the vault root.
      suppressErrors: true,
    });

    // Read in batches, then fold in input order so the map's iteration order
    // (and the order `onUnreadable` fires) stays what a serial crawl produced.
    const read = await mapInBatches(historyFiles, async (file) => {
      // Extract doc ID from path: e.g. "nodes/.versions/api-design/history.yaml" -> "nodes/api-design"
      const parts = file.split("/");
      const versionsIdx = parts.indexOf(".versions");
      if (versionsIdx === -1) return null;
      const docDir = parts.slice(0, versionsIdx).join("/");
      const docName = parts[versionsIdx + 1];
      const docId = docDir ? `${docDir}/${docName}` : docName;
      try {
        const raw = yaml.load(await readFile(join(this.root, file), "utf-8"));
        return { docId, raw, error: null as string | null };
      } catch (err) {
        return { docId, raw: null, error: err instanceof Error ? err.message : String(err) };
      }
    });

    const histories = new Map<string, DocumentHistory>();
    for (const entry of read) {
      if (!entry) continue;
      if (entry.error !== null) {
        onUnreadable?.(entry.docId, entry.error);
        continue;
      }
      const result = documentHistorySchema.safeParse(entry.raw);
      if (result.success) {
        histories.set(entry.docId, result.data as DocumentHistory);
      } else {
        onUnreadable?.(entry.docId, `history.yaml failed schema validation`);
      }
    }

    return histories;
  }

  /**
   * Initialize a new vault with the given layout mode.
   */
  async init(
    name: string,
    layout: LayoutMode = "structured",
    description?: string,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true });

    if (layout === "structured") {
      await mkdir(join(this.root, "nodes"), { recursive: true });
      await mkdir(join(this.root, "sources"), { recursive: true });
      await mkdir(join(this.root, "packs"), { recursive: true });
    }

    await mkdir(join(this.root, ".context"), { recursive: true });
    await mkdir(join(this.root, ".versions"), { recursive: true });

    // Write default config. The description is the nest's OWN (spec §11.1) — it
    // travels with the vault, unlike the registry entry's machine-local label.
    const config: NestConfig = {
      version: 1,
      name,
      ...(description?.trim() ? { description } : {}),
      defaults: { status: "draft" },
    };
    await this.writeConfig(config);

    // Write CONTEXT.md
    const contextMd = `---
title: "${name}"
---

# ${name}

## How to Use This Vault

1. Read \`.context/config.yaml\` for nest configuration and folder descriptions
2. Read \`INDEX.md\` for a summary of all documents, their types, status, and tags
3. Use \`context.yaml\` to understand the document graph
4. Start with hub documents (highest inbound links) for broad context
5. Follow \`contextnest://\` links within documents to traverse related content

## Operating Instructions

- Always cite sources by document path
- Prefer published documents over drafts
`;
    await this.writeContextMd(contextMd);
  }
}
