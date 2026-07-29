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
import { publishDocument } from "../publish.js";
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

/** True if a document already exists at `id` (readDocument throws when absent). */
async function documentExists(ctx: OperationContext, id: string): Promise<boolean> {
  try {
    await ctx.storage.readDocument(id);
    return true;
  } catch (err) {
    if (err instanceof ContextNestError && err.code === "DOCUMENT_NOT_FOUND") return false;
    throw err;
  }
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

const create: OperationExecutor = async (ctx, input: any) => {
  // Slugify each folder segment and always root under nodes/ so the doc is
  // discoverable (normalizeDocumentId only prepends nodes/ when there is no
  // slash — a raw "gtm/deals/x" would escape the discoverable tree).
  const folderSegments = String(input.folder ?? "")
    .split("/")
    .map(slugify)
    .filter(Boolean);
  const id = normalizeDocumentId(["nodes", ...folderSegments, requireSlug(input.title)].join("/"));
  // Refuse to clobber an existing doc (mirrors OSS create_document). Without
  // this, a colliding title overwrites the prior node AND resurrects a rejected
  // one into retrieval — the exact invariant `update` guards via isRejected.
  if (await documentExists(ctx, id)) {
    throw new ContextNestError(`Document "${id}" already exists`, "DOCUMENT_ALREADY_EXISTS");
  }
  const frontmatter: Frontmatter = {
    title: input.title,
    type: input.type ?? "document",
    ...(input.tags ? { tags: normalizeUniqueTags(input.tags) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    status: "draft",
    created_at: new Date().toISOString(),
  };
  const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body: input.content };
  assertValid(node);
  await ctx.storage.writeDocument(id, serializeDocument(node));
  const result = await publishAndIndex(ctx, id);
  return { id, version: result.version };
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

/** name → executor for the built-in `core` namespace. */
export const CORE_EXECUTORS: Readonly<Record<string, OperationExecutor>> = Object.freeze({
  context_query: query,
  context_resolve: resolve,
  context_search: search,
  context_get: get,
  context_list: list,
  context_create: create,
  context_update: update,
});
