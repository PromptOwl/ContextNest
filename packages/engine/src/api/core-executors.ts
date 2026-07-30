/**
 * Executors for the `core` namespace — the SINGLE implementation of each core
 * operation, bound to the engine primitives. These replace the copy of this
 * logic currently living in Community MCP (`tools.ts`), Community REST
 * (`query-routes.ts`), OSS mcp-server, and OSS CLI.
 *
 * Everything here is **ungated mechanics**. No commercial governance: the only
 * policy seam is the identity-agnostic `RbacHook` on the context. Stewardship
 * enforcement is layered by a Community extension's `authorize` hook (see
 * `extension.ts`). Behaviour is reconciled against CONTEXT_NEST_SPEC.md and the
 * existing surfaces (published-only search, index regeneration after publish,
 * status/tag normalization, document validation before write).
 */
import type { ContextNode, Frontmatter } from "../types.js";
import {
  serializeDocument,
  validateDocument,
  normalizeTags,
  normalizeStatus,
  isRejected,
} from "../parser.js";
import { normalizeDocumentId } from "../storage.js";
import { publishDocument, publishDocuments } from "../publish.js";
import { VersionManager } from "../versioning.js";
import { parseUri } from "../uri.js";
import { ContextNestError, RejectedDocumentError } from "../errors.js";
import type { OperationContext, OperationExecutor } from "./context.js";

/** Community/engine cap on graph traversal depth (community MAX_HOPS). */
const MAX_HOPS = 10;

/** ContextNode → the wire `nodeSummary` shape. Source nodes keep their block. */
function toSummary(node: ContextNode, includeBody = false) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type ?? "document",
    status: node.frontmatter.status ?? "draft",
    tags: node.frontmatter.tags,
    ...(node.frontmatter.type === "source" && node.frontmatter.source
      ? { source: node.frontmatter.source }
      : {}),
    ...(includeBody ? { body: node.body } : {}),
  };
}

/** Lowercase, hyphenate — used to derive a slug from a title/folder segment. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // collapse each non-alphanumeric run to ONE dash
    .replace(/^-|-$/g, ""); // runs are already collapsed, so trim a single edge dash
  // (linear — avoids the `-+$` polynomial-backtracking ReDoS CodeQL flags)
}

/** Clamp a caller-supplied hop count into [0, MAX_HOPS]. */
function clampHops(hops: unknown): number {
  const n = typeof hops === "number" ? hops : 2;
  return Math.max(0, Math.min(MAX_HOPS, n));
}

/**
 * Slugify a title, rejecting titles with no slug-able characters (all-CJK,
 * all-emoji, all-punctuation) rather than producing a degenerate `nodes/.md`.
 */
function requireSlug(title: string): string {
  const slug = slugify(title);
  if (!slug) {
    throw new ContextNestError(
      `Title "${title}" has no slug-able (a-z0-9) characters; supply an explicit id/folder`,
      "VALIDATION_FAILED",
    );
  }
  return slug;
}

/** Normalize (#-prefix) and de-duplicate a tag list. */
function normalizeUniqueTags(tags?: unknown[]): string[] | undefined {
  const normalized = normalizeTags(tags);
  return normalized ? [...new Set(normalized)] : normalized;
}

/**
 * Resolve a document id from an id / uri / title selector. Title resolves to
 * the *actual* frontmatter title across discovered docs (matches how every
 * surface resolves title→id), falling back to a slugified id under nodes/.
 */
async function resolveId(
  ctx: OperationContext,
  sel: { id?: string; uri?: string; title?: string },
): Promise<string> {
  if (sel.id) return normalizeDocumentId(sel.id);
  if (sel.uri) return normalizeDocumentId(parseUri(sel.uri).path);
  const docs = await ctx.storage.discoverDocuments();
  const match = docs.find(
    (d) => d.frontmatter.title.toLowerCase() === String(sel.title).toLowerCase(),
  );
  if (match) return match.id;
  return normalizeDocumentId(requireSlug(String(sel.title)));
}

/** Validate a node against the spec (§13) before it is written/published. */
function assertValid(node: ContextNode): void {
  const result = validateDocument(node);
  if (!result.valid) {
    throw new ContextNestError(
      `Document validation failed: ${result.errors.map((e) => e.message).join("; ")}`,
      "VALIDATION_FAILED",
    );
  }
}

/** Publish via publishDocument, then regenerate context.yaml (matches OSS). */
async function publishAndIndex(ctx: OperationContext, id: string): Promise<{ version: number }> {
  const res = await publishDocument(ctx.storage, id, { editedBy: ctx.actor ?? "engine" });
  // publishDocument does NOT touch context.yaml; graph-mode reads (the default
  // context_query) seed from it, so a stale index would hide the write. OSS
  // mcp-server/CLI both regenerate here.
  await ctx.storage.regenerateIndex();
  return { version: res.versionEntry.version };
}

const query: OperationExecutor = async (ctx, input: any) => {
  const result = await ctx.query.query(input.query, {
    hops: clampHops(input.hops),
    full: input.full ?? false,
  });
  return {
    documents: result.documents.map((d) => toSummary(d, true)),
    source_nodes: result.sourceNodes?.map((d) => toSummary(d, true)),
    traversal: {
      mode: result.mode,
      hops_used: result.hopsUsed,
      nodes_traversed: result.nodesTraversed,
    },
  };
};

const resolve: OperationExecutor = async (ctx, input: any) => {
  // Honour `hops` — graph mode traverses the neighbourhood; forcing full mode
  // would make the advertised hops a no-op (fullQuery reports hopsUsed:0).
  const result = await ctx.query.query(input.selector, {
    hops: clampHops(input.hops),
    full: false,
  });
  const budget = input.max_tokens ?? 8000;
  const documents: Array<{ id: string; frontmatter: Frontmatter; body: string }> = [];
  let tokens = 0;
  let truncated = false;
  for (const d of result.documents) {
    const cost = Math.ceil((d.body?.length ?? 0) / 4); // ~4 chars/token
    if (tokens + cost > budget && documents.length > 0) {
      truncated = true;
      break;
    }
    tokens += cost;
    documents.push({ id: d.id, frontmatter: d.frontmatter, body: d.body });
  }
  return { documents, tokens_used: tokens, truncated };
};

const search: OperationExecutor = async (ctx, input: any) => {
  // Go through the engine's published-only, ranked full-text search (the
  // `contextnest://search/…` resolver, which indexes title/description/body/tags
  // and filters to published) instead of a hand-rolled substring scorer — never
  // leaks unpublished content. `full: true` routes through the Resolver; graph
  // mode would only match context.yaml metadata (no body).
  // Slugify the query before embedding it in the URI. This string is re-lexed
  // by the selector grammar, whose URI token terminates on whitespace/+/|/()
  // (lexer.ts), and parseUri rejects '//'. Raw user text (spaces, a '/' from a
  // pasted URL, '+') would truncate the token or throw INVALID_URI. Hyphens are
  // lexer-safe URI path chars and MiniSearch tokenizes on them, so slugifying
  // keeps recall while guaranteeing a single well-formed URI token.
  const q = slugify(String(input.query));
  if (!q) return { results: [] };
  const result = await ctx.query.query(`contextnest://search/${q}`, { full: true });
  const docs = input.limit ? result.documents.slice(0, input.limit) : result.documents;
  return { results: docs.map((d) => toSummary(d)) };
};

const get: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  const node = await ctx.storage.readDocument(id);
  // Consistent rejected handling (the descriptor advertises REJECTED_DOCUMENT).
  if (isRejected(node)) throw new RejectedDocumentError(node.id);
  return { id: node.id, frontmatter: node.frontmatter, body: node.body };
};

const list: OperationExecutor = async (ctx, input: any) => {
  let docs = await ctx.storage.discoverDocuments();
  if (input.type) docs = docs.filter((d) => d.frontmatter.type === input.type);
  if (input.status) {
    const want = normalizeStatus(input.status);
    docs = docs.filter((d) => normalizeStatus(d.frontmatter.status ?? "draft") === want);
  }
  if (input.tag) {
    const want = String(input.tag).replace(/^#/, "");
    docs = docs.filter((d) => d.frontmatter.tags?.some((t) => t.replace(/^#/, "") === want));
  }
  if (input.limit) docs = docs.slice(0, input.limit);
  return { documents: docs.map((d) => toSummary(d)) };
};

/**
 * Build a fresh draft node from create/import input. Slugifies each folder
 * segment and always roots under nodes/ so the doc is discoverable
 * (normalizeDocumentId only prepends nodes/ when there is no slash — a raw
 * "gtm/deals/x" would escape the discoverable tree). Shared by `create` and
 * the bulk `import` executor so their node shape stays identical.
 */
function buildDraftNode(input: {
  title: string;
  content: string;
  type?: string;
  tags?: unknown[];
  folder?: string;
  metadata?: Record<string, unknown>;
}): ContextNode {
  const folderSegments = String(input.folder ?? "")
    .split("/")
    .map(slugify)
    .filter(Boolean);
  const id = normalizeDocumentId(["nodes", ...folderSegments, requireSlug(input.title)].join("/"));
  const frontmatter: Frontmatter = {
    title: input.title,
    type: (input.type as Frontmatter["type"]) ?? "document",
    ...(input.tags ? { tags: normalizeUniqueTags(input.tags) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    status: "draft",
    created_at: new Date().toISOString(),
  };
  return { id, filePath: "", rawContent: "", frontmatter, body: input.content };
}

const create: OperationExecutor = async (ctx, input: any) => {
  const node = buildDraftNode(input);
  assertValid(node);
  // Exclusive write: atomically refuses to clobber an existing doc (mirrors OSS
  // create_document) — no TOCTOU window, and blocks resurrecting a rejected doc
  // the way the pre-check + separate write could race.
  await ctx.storage.writeDocument(node.id, serializeDocument(node), { exclusive: true });
  const result = await publishAndIndex(ctx, node.id);
  return { id: node.id, version: result.version };
};

const update: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  const existing = await ctx.storage.readDocument(id);
  // Guard BEFORE any write: republishing a rejected doc would flip it back into
  // retrieval, and writing first would mutate the file even though publish then
  // rejects (no version/checksum/history). Mirrors OSS update_document.
  if (isRejected(existing)) throw new RejectedDocumentError(id);
  const frontmatter: Frontmatter = { ...existing.frontmatter };
  if (input.tags) {
    const merged = [...(frontmatter.tags ?? []), ...input.tags];
    frontmatter.tags = normalizeUniqueTags(merged);
  }
  if (input.metadata) {
    frontmatter.metadata = { ...(frontmatter.metadata ?? {}), ...input.metadata };
  }
  let body = existing.body;
  if (typeof input.content === "string") body = input.content;
  if (typeof input.append === "string") body = `${body}\n${input.append}`;
  const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body };
  assertValid(node);
  await ctx.storage.writeDocument(id, serializeDocument(node));
  const result = await publishAndIndex(ctx, id);
  return { id, version: result.version };
};

const publish: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  // publishDocument guards rejected docs and seals a checkpoint; regenerate the
  // index so graph-mode reads see the freshly-published node (same as create/update).
  const result = await publishDocument(ctx.storage, id, { editedBy: ctx.actor ?? "engine" });
  await ctx.storage.regenerateIndex();
  return { id, version: result.versionEntry.version, checkpoint: result.checkpointNumber };
};

const del: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  // deleteDocument throws DOCUMENT_NOT_FOUND when the id doesn't exist.
  await ctx.storage.deleteDocument(id);
  await ctx.storage.regenerateIndex();
  return { id, deleted: true as const };
};

const versions: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  const history = await ctx.storage.readHistory(id);
  if (!history) {
    // No history yet (never published). Confirm the doc exists so a bogus
    // id/title still surfaces DOCUMENT_NOT_FOUND rather than an empty list.
    await ctx.storage.readDocument(id);
    return { id, keyframe_interval: 0, versions: [] };
  }
  // Change logs are opt-in — see the `include_diff` note on the descriptor.
  const versionManager = input?.include_diff
    ? new VersionManager(ctx.storage)
    : null;
  return {
    id,
    keyframe_interval: history.keyframe_interval,
    versions: await Promise.all(
      history.versions.map(async (v) => ({
        version: v.version,
        keyframe: v.keyframe ?? false,
        edited_by: v.edited_by,
        edited_at: v.edited_at,
        published_at: v.published_at,
        note: v.note,
        content_hash: v.content_hash,
        chain_hash: v.chain_hash,
        ...(versionManager
          ? { diff: (await versionManager.getDiff(id, v.version)) ?? undefined }
          : {}),
      })),
    ),
  };
};

const overview: OperationExecutor = async (ctx) => {
  const docs = await ctx.storage.discoverDocuments();
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const tags = new Set<string>();
  for (const d of docs) {
    const t = d.frontmatter.type ?? "document";
    byType[t] = (byType[t] ?? 0) + 1;
    const s = d.frontmatter.status ?? "draft";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    for (const tag of d.frontmatter.tags ?? []) tags.add(tag);
  }
  return {
    total: docs.length,
    by_type: byType,
    by_status: byStatus,
    tags: [...tags].sort(),
    nodes: docs.map((d) => toSummary(d)),
  };
};

const reconstruct: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  // Surface DOCUMENT_NOT_FOUND for a bogus id/title (the descriptor advertises it).
  await ctx.storage.readDocument(id);
  try {
    const content = await ctx.versions.reconstructVersion(id, input.version);
    return { id, version: input.version, content };
  } catch (err) {
    if (err instanceof ContextNestError) throw err;
    // reconstructVersion throws plain Error (no .code) for missing history,
    // an out-of-range version, or a corrupt keyframe. Map to VALIDATION_FAILED
    // so callers can dispatch on the advertised error contract.
    throw new ContextNestError(
      err instanceof Error ? err.message : String(err),
      "VALIDATION_FAILED",
    );
  }
};

const verify: OperationExecutor = async (ctx) => {
  const report = await ctx.storage.verifyVaultIntegrity();
  return { valid: report.valid, errors: report.errors };
};

const init: OperationExecutor = async (ctx) => {
  return { context_md: await ctx.storage.readContextMd() };
};

const packs: OperationExecutor = async (ctx) => {
  const all = await ctx.storage.readPacks();
  return {
    packs: all.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      query: p.query,
      agent_instructions: p.agent_instructions,
    })),
  };
};

const importDocs: OperationExecutor = async (ctx, input: any) => {
  const created: { id: string; version: number }[] = [];
  const failed: { title: string; error: string }[] = [];
  const titleById = new Map<string, string>();

  // Stage 1: write every doc as a draft (exclusive → dup/invalid go to failed).
  const writtenIds: string[] = [];
  for (const doc of input.documents) {
    try {
      const node = buildDraftNode(doc);
      assertValid(node);
      await ctx.storage.writeDocument(node.id, serializeDocument(node), { exclusive: true });
      writtenIds.push(node.id);
      titleById.set(node.id, doc.title);
    } catch (err) {
      failed.push({ title: doc.title, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Stage 2: bulk-publish the drafts — ONE checkpoint + ONE index regen for the
  // whole batch (the O(N) path), instead of a checkpoint per document.
  if (writtenIds.length > 0) {
    const result = await publishDocuments(ctx.storage, writtenIds, {
      editedBy: ctx.actor ?? "engine",
    });
    for (const p of result.published) created.push({ id: p.id, version: p.version });
    for (const f of result.failed) {
      failed.push({ title: titleById.get(f.id) ?? f.id, error: f.error });
    }
  }

  return { created, failed };
};

/** name → executor for the built-in `core` namespace. */
export const CORE_EXECUTORS: Readonly<Record<string, OperationExecutor>> = Object.freeze({
  context_query: query,
  context_resolve: resolve,
  context_search: search,
  context_get: get,
  context_list: list,
  context_create: create,
  context_update: update,
  context_publish: publish,
  context_delete: del,
  context_versions: versions,
  context_reconstruct: reconstruct,
  context_overview: overview,
  context_verify: verify,
  context_init: init,
  context_packs: packs,
  context_import: importDocs,
});
