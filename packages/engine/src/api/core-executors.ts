/**
 * Executors for the `core` namespace — the SINGLE implementation of each core
 * operation, bound to the engine primitives. These replace the copy of this
 * logic currently living in Community MCP (`tools.ts`), Community REST
 * (`query-routes.ts`), OSS mcp-server, and OSS CLI.
 *
 * Everything here is **ungated mechanics**. No commercial governance: the only
 * policy seam is the identity-agnostic `RbacHook` on the context, and it is not
 * consulted for these ungated core reads/writes. Stewardship enforcement is
 * layered by a Community extension's `authorize` hook (see `extension.ts`).
 */
import type { ContextNode, Frontmatter } from "../types.js";
import { serializeDocument } from "../parser.js";
import { normalizeDocumentId } from "../storage.js";
import { parseUri } from "../uri.js";
import type { OperationContext, OperationExecutor } from "./context.js";

/** ContextNode → the wire `nodeSummary` shape. */
function toSummary(node: ContextNode, includeBody = false) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type ?? "document",
    status: node.frontmatter.status ?? "draft",
    tags: node.frontmatter.tags,
    ...(includeBody ? { body: node.body } : {}),
  };
}

/** Lowercase, hyphenate — used to derive a slug from a title for create. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const query: OperationExecutor = async (ctx, input: any) => {
  const result = await ctx.query.query(input.query, {
    hops: input.hops ?? 2,
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
  const result = await ctx.query.query(input.selector, {
    hops: input.hops ?? 2,
    full: true,
  });
  const budget = input.max_tokens ?? 8000;
  const documents: Array<{ id: string; frontmatter: Frontmatter; body: string }> = [];
  let tokens = 0;
  let truncated = false;
  for (const d of result.documents) {
    // ~4 chars/token is the usual rough estimate.
    const cost = Math.ceil((d.body?.length ?? 0) / 4);
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
  const terms = String(input.query).toLowerCase().split(/\s+/).filter(Boolean);
  const docs = await ctx.storage.discoverDocuments();
  const scored = docs
    .map((d) => {
      const haystack = [
        d.frontmatter.title,
        d.frontmatter.tags?.join(" ") ?? "",
        d.body ?? "",
      ]
        .join(" ")
        .toLowerCase();
      const score = terms.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
      return { d, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const limited = input.limit ? scored.slice(0, input.limit) : scored;
  return { results: limited.map((s) => ({ ...toSummary(s.d), score: s.score })) };
};

const get: OperationExecutor = async (ctx, input: any) => {
  let id: string | undefined = input.id;
  if (!id && input.uri) id = parseUri(input.uri).path;
  if (id) {
    const node = await ctx.storage.readDocument(normalizeDocumentId(id));
    return { id: node.id, frontmatter: node.frontmatter, body: node.body };
  }
  // Resolve by title across the vault.
  const docs = await ctx.storage.discoverDocuments();
  const match = docs.find(
    (d) => d.frontmatter.title.toLowerCase() === String(input.title).toLowerCase(),
  );
  if (!match) {
    const node = await ctx.storage.readDocument(normalizeDocumentId(String(input.title)));
    return { id: node.id, frontmatter: node.frontmatter, body: node.body };
  }
  return { id: match.id, frontmatter: match.frontmatter, body: match.body };
};

const list: OperationExecutor = async (ctx, input: any) => {
  let docs = await ctx.storage.discoverDocuments();
  if (input.type) docs = docs.filter((d) => d.frontmatter.type === input.type);
  if (input.status) docs = docs.filter((d) => (d.frontmatter.status ?? "draft") === input.status);
  if (input.tag) {
    const want = String(input.tag).replace(/^#/, "");
    docs = docs.filter((d) => d.frontmatter.tags?.some((t) => t.replace(/^#/, "") === want));
  }
  if (input.limit) docs = docs.slice(0, input.limit);
  return { documents: docs.map((d) => toSummary(d)) };
};

const create: OperationExecutor = async (ctx, input: any) => {
  const slug = slugify(input.title);
  const rawId = input.folder ? `${input.folder}/${slug}` : slug;
  const id = normalizeDocumentId(rawId);
  const frontmatter: Frontmatter = {
    title: input.title,
    type: input.type ?? "document",
    ...(input.tags ? { tags: input.tags } : {}),
    status: "draft",
  };
  // filePath/rawContent are unused by serializeDocument (it reads frontmatter +
  // body only); the CLI's `add` constructs the node the same way.
  const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body: input.content };
  await ctx.storage.writeDocument(id, serializeDocument(node));
  const result = await publish(ctx, id);
  return { id, version: result.version };
};

const update: OperationExecutor = async (ctx, input: any) => {
  const id = normalizeDocumentId(input.id ?? slugifyId(ctx, input.title));
  const existing = await ctx.storage.readDocument(id);
  const frontmatter: Frontmatter = { ...existing.frontmatter };
  if (input.tags) {
    const merged = new Set([...(frontmatter.tags ?? []), ...input.tags]);
    frontmatter.tags = [...merged];
  }
  let body = existing.body;
  if (typeof input.content === "string") body = input.content;
  if (typeof input.append === "string") body = `${body}\n${input.append}`;
  const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body };
  await ctx.storage.writeDocument(id, serializeDocument(node));
  const result = await publish(ctx, id);
  return { id, version: result.version };
};

/** Resolve an update target by title when no id was supplied. */
function slugifyId(_ctx: OperationContext, title: string): string {
  return title;
}

/** Publish via the engine's publishDocument, using the context actor. */
async function publish(ctx: OperationContext, id: string): Promise<{ version: number }> {
  // Imported lazily to keep the module graph flat; publish.ts pulls in a lot.
  const { publishDocument } = await import("../publish.js");
  const res = await publishDocument(ctx.storage, id, {
    editedBy: ctx.actor ?? "engine",
  });
  return { version: res.versionEntry.version };
}

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
