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
import type { ContextNode, Frontmatter, SkillMeta } from "../types.js";
import {
  serializeDocument,
  validateDocument,
  normalizeTags,
  normalizeStatus,
  isRejected,
} from "../parser.js";
import { normalizeDocumentId, assertSafeDocumentId } from "../storage.js";
import { filterDocuments } from "../filters.js";
import { listVaults } from "../registry.js";
import { publishDocument, publishDocuments } from "../publish.js";
import { VersionManager } from "../versioning.js";
import { parseUri } from "../uri.js";
import { ContextNestError, RejectedDocumentError } from "../errors.js";
import type { OperationContext, OperationExecutor } from "./context.js";

/** Community/engine cap on graph traversal depth (community MAX_HOPS). */
const MAX_HOPS = 10;

/** ContextNode → the wire `nodeSummary` shape. Source nodes keep their block. */
function toSummary(node: ContextNode, includeBody = false, includeFrontmatter = false) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type ?? "document",
    status: node.frontmatter.status ?? "draft",
    tags: node.frontmatter.tags,
    ...(node.frontmatter.description ? { description: node.frontmatter.description } : {}),
    ...(node.frontmatter.type === "source" && node.frontmatter.source
      ? { source: node.frontmatter.source }
      : {}),
    ...(includeBody ? { body: node.body } : {}),
    ...(includeFrontmatter ? { frontmatter: node.frontmatter } : {}),
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
  // Enforced here rather than as a `.refine` on the descriptors: a refine turns
  // the input into a ZodEffects with no `.shape`, and an MCP tool registered
  // from that advertises no parameters at all. Same error, raised a moment
  // later, and every transport reports it the same way.
  if (!sel.id && !sel.uri && !sel.title) {
    throw new ContextNestError(
      "One of uri, id, or title is required",
      "VALIDATION_FAILED",
    );
  }
  // Vetted, NOT normalized: normalizeDocumentId re-roots a bare slug under
  // `nodes/`, which silently redirects every id from a flat-layout vault (they
  // carry no prefix) to a document that does not exist. The storage layer
  // resolves an id for its own layout — same rule context_update and
  // context_import's `ids` already follow.
  if (sel.id) {
    assertSafeDocumentId(sel.id);
    return sel.id;
  }
  if (sel.uri) {
    const path = parseUri(sel.uri).path;
    assertSafeDocumentId(path);
    return path;
  }
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
async function publishAndIndex(
  ctx: OperationContext,
  id: string,
  note?: string,
): Promise<{ version: number; checkpoint: number }> {
  const res = await publishDocument(ctx.storage, id, {
    editedBy: ctx.actor ?? "engine",
    ...(note ? { note } : {}),
  });
  // publishDocument does NOT touch context.yaml; graph-mode reads (the default
  // context_query) seed from it, so a stale index would hide the write. OSS
  // mcp-server/CLI both regenerate here.
  await ctx.storage.regenerateIndex();
  return { version: res.versionEntry.version, checkpoint: res.checkpointNumber };
}

const query: OperationExecutor = async (ctx, input: any) => {
  const result = await ctx.query.query(input.query, {
    hops: clampHops(input.hops),
    full: input.full ?? false,
    includeDrafts: input.include_drafts ?? false,
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
  const node = await ctx.storage.readDocument(
    id,
    input.verify_checksum ? { verifyChecksum: true } : undefined,
  );
  // Consistent rejected handling (the descriptor advertises REJECTED_DOCUMENT).
  // Surfaces that let a steward see and revive a retired document opt out —
  // reading one is not the same as republishing it.
  if (isRejected(node) && !input.allow_rejected) throw new RejectedDocumentError(node.id);
  return {
    id: node.id,
    frontmatter: node.frontmatter,
    body: node.body,
    ...(input.include_raw ? { raw: node.rawContent } : {}),
    ...(node.pendingChange ? { pendingChange: node.pendingChange } : {}),
  };
};

const list: OperationExecutor = async (ctx, input: any) => {
  // includeRetired, or `status: "rejected"` matches nothing: discovery drops
  // retired documents before the filter ever sees them. filterDocuments hides
  // them again whenever no status was asked for.
  const docs = await ctx.storage.discoverDocuments({ includeRetired: true });
  const kept = filterDocuments(docs, { ...input, includeRetired: input.include_retired });
  return { documents: kept.map((d) => toSummary(d, input.full === true, input.full === true)) };
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
  id?: string;
  status?: Frontmatter["status"];
  trigger?: string;
  tools_required?: string[];
  output_format?: SkillMeta["output_format"];
  inputs?: SkillMeta["inputs"];
  guard_rails?: string[];
}): ContextNode {
  const now = new Date().toISOString();
  const folderSegments = String(input.folder ?? "")
    .split("/")
    .map(slugify)
    .filter(Boolean);
  // An explicit id wins outright — callers that mint their own ids (system
  // nodes, path-addressed tools) still get the traversal/prefix normalization.
  const id = input.id
    ? normalizeDocumentId(input.id)
    : normalizeDocumentId(["nodes", ...folderSegments, requireSlug(input.title)].join("/"));
  const frontmatter: Frontmatter = {
    title: input.title,
    type: (input.type as Frontmatter["type"]) ?? "document",
    ...(input.tags ? { tags: normalizeUniqueTags(input.tags) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    // Skill nodes carry a `skill` block — `trigger` is required there for
    // type:"skill" and the block must be ABSENT on every other type, so these
    // cannot ride along inside `metadata`.
    ...(input.trigger
      ? {
          skill: {
            trigger: input.trigger,
            ...(input.inputs ? { inputs: input.inputs } : {}),
            ...(input.tools_required ? { tools_required: input.tools_required } : {}),
            ...(input.output_format ? { output_format: input.output_format } : {}),
            ...(input.guard_rails ? { guard_rails: input.guard_rails } : {}),
          },
        }
      : {}),
    status: (input.status as Frontmatter["status"]) ?? "draft",
    created_at: now,
    // A node is "updated" at birth; without this a draft carries no
    // updated_at until its first edit, and every surface renders it blank.
    updated_at: now,
  };
  return { id, filePath: "", rawContent: "", frontmatter, body: input.content };
}

const create: OperationExecutor = async (ctx, input: any) => {
  const node = buildDraftNode(input);
  // Publish assigns the version (spec §6), so a published node must go to disk
  // WITHOUT one — pre-setting it makes the first published version 2 and leaves
  // no v1 keyframe. A draft never reaches publish, so it needs its own v1.
  if (input.publish === false) node.frontmatter.version = 1;
  const createdStatus = node.frontmatter.status;
  assertValid(node);
  // Exclusive write: atomically refuses to clobber an existing doc (mirrors OSS
  // create_document) — no TOCTOU window, and blocks resurrecting a rejected doc
  // the way the pre-check + separate write could race.
  await ctx.storage.writeDocument(node.id, serializeDocument(node), { exclusive: true });
  // Governed callers create the node WITHOUT publishing: the write has to clear
  // review before it becomes retrievable. Still regenerate the index so the
  // draft is discoverable to the surfaces that list drafts.
  if (input.publish === false) {
    await ctx.storage.regenerateIndex();
    return {
      id: node.id,
      version: node.frontmatter.version ?? 1,
      status: createdStatus,
      checkpoint: null,
    };
  }
  const result = await publishAndIndex(ctx, node.id, input.note);
  return {
    id: node.id,
    version: result.version,
    status: "published",
    checkpoint: result.checkpoint,
  };
};

/**
 * Statuses that describe where a node sits in review, not a content release.
 * Setting one is a metadata transition, so it doesn't publish by default — the
 * rule CLI and mcp-server each hand-rolled before this op absorbed it.
 */
const UNPUBLISHED_STATUSES = new Set(["draft", "pending_review", "approved", "rejected"]);

const update: OperationExecutor = async (ctx, input: any) => {
  // Vetted, NOT normalized: normalizeDocumentId re-roots a bare slug under
  // `nodes/`, which silently redirects every id from a flat-layout vault (they
  // carry no prefix) to a document that doesn't exist. The storage layer
  // already resolves an id for its own layout — all this has to do is refuse
  // one that would escape the vault root.
  const id: string = input.id;
  assertSafeDocumentId(id);
  const existing = await ctx.storage.readDocument(id);
  // Guard BEFORE any write: republishing a rejected doc would flip it back into
  // retrieval, and writing first would mutate the file even though publish then
  // rejects (no version/checksum/history). Naming a `status` is how a caller
  // revives one, so only a status-less edit is refused — mirrors OSS
  // update_document.
  if (isRejected(existing) && input.status === undefined) throw new RejectedDocumentError(id);
  const frontmatter: Frontmatter = { ...existing.frontmatter };
  if (input.title) frontmatter.title = input.title;
  if (input.status) frontmatter.status = input.status as Frontmatter["status"];
  if (input.tags) frontmatter.tags = normalizeUniqueTags(input.tags);
  if (input.metadata) {
    const merged: Record<string, unknown> = {
      ...(frontmatter.metadata ?? {}),
      ...input.metadata,
    };
    // A null value CLEARS the key. Over a JSON wire an absent key is
    // indistinguishable from "leave this alone", so a merge with no null
    // convention gives callers no way to remove metadata at all. Only keys the
    // caller named are considered — a null already on disk is left alone.
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === null) delete merged[key];
    }
    frontmatter.metadata = merged;
  }
  frontmatter.updated_at = new Date().toISOString();
  let body = existing.body;
  if (typeof input.content === "string") body = input.content;
  if (typeof input.append === "string") body = `${body}\n${input.append}`;
  // The checksum describes the PUBLISHED body, so any body change invalidates
  // it — including one whose publish then fails, which would otherwise leave a
  // stale checksum on disk and make the next verified read cry external drift.
  // Frontmatter-only edits keep it: the checksum covers the body alone.
  if (typeof input.content === "string" || typeof input.append === "string") {
    delete frontmatter.checksum;
  }

  const publish = input.publish ?? !(input.status && UNPUBLISHED_STATUSES.has(input.status));
  // Only an unpublished write may carry a caller-assigned version: publish
  // assigns its own, and stamping one first would put the node a version ahead
  // of its history (the same trap context_create avoids).
  if (!publish && input.version !== undefined) frontmatter.version = input.version;
  const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body };
  assertValid(node);
  await ctx.storage.writeDocument(id, serializeDocument(node));
  if (!publish) {
    await ctx.storage.regenerateIndex();
    return {
      id,
      version: frontmatter.version ?? 1,
      status: frontmatter.status ?? "draft",
      checkpoint: null,
    };
  }
  const result = await publishAndIndex(ctx, id, input.note);
  return { id, version: result.version, status: "published", checkpoint: result.checkpoint };
};

const publish: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  // publishDocument guards rejected docs and seals a checkpoint; regenerate the
  // index so graph-mode reads see the freshly-published node (same as create/update).
  const result = await publishDocument(ctx.storage, id, {
    editedBy: ctx.actor ?? "engine",
    ...(input.note ? { note: input.note } : {}),
  });
  await ctx.storage.regenerateIndex();
  return {
    id,
    version: result.versionEntry.version,
    checkpoint: result.checkpointNumber,
    chain_hash: result.versionEntry.chain_hash,
  };
};

const del: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  // Read the title BEFORE removing the file — callers report what they deleted,
  // and after the delete there is nothing left to ask.
  const { frontmatter } = await ctx.storage.readDocument(id);
  // deleteDocument throws DOCUMENT_NOT_FOUND when the id doesn't exist.
  await ctx.storage.deleteDocument(id);
  await ctx.storage.regenerateIndex();
  return { id, title: frontmatter.title, deleted: true as const };
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


const reconstruct: OperationExecutor = async (ctx, input: any) => {
  const id = await resolveId(ctx, input);
  // Surface DOCUMENT_NOT_FOUND for a bogus id/title (the descriptor advertises it).
  await ctx.storage.readDocument(id);
  try {
    const content = await ctx.versions.reconstructVersion(id, input.version);
    return { id, version: input.version, content };
  } catch (err) {
    // reconstructVersion codes its own failures (VERSION_NOT_FOUND,
    // RECONSTRUCTION_FAILED) — pass those through. Anything uncoded that leaks
    // from the storage layer still gets a code so callers can dispatch on the
    // advertised error contract.
    if (err instanceof ContextNestError) throw err;
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

const init: OperationExecutor = async (ctx, input: any) => {
  // includeRetired so `by_status` can report `rejected` at all — discovery drops
  // retired documents otherwise, and a manifest that silently omits a whole
  // status is worse than one that reports zero.
  const [context_md, config, docs] = await Promise.all([
    ctx.storage.readContextMd(),
    ctx.storage.readConfig(),
    ctx.storage.discoverDocuments({ includeRetired: true }),
  ]);
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
  const listed = input?.limit ? docs.slice(0, input.limit) : docs;
  return {
    context_md,
    vault_path: ctx.storage.root,
    config: config
      ? {
          name: config.name,
          ...(config.description ? { description: config.description } : {}),
          servers: config.servers ? Object.keys(config.servers) : [],
        }
      : null,
    total: docs.length,
    by_type: byType,
    by_status: byStatus,
    tags: [...tags].sort(),
    // Counts and tags answer most opening questions; a large vault's node list
    // dwarfs them, so it is opt-in.
    ...(input?.include_nodes ? { nodes: listed.map((d) => toSummary(d)) } : {}),
  };
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
      ...(p.includes ? { includes: p.includes } : {}),
      ...(p.excludes ? { excludes: p.excludes } : {}),
    })),
  };
};

// Registry-scoped: no `ctx` use. Deliberate — see context_nests in api/README.md.
const nests: OperationExecutor = () => ({ nests: listVaults() });

const importDocs: OperationExecutor = async (ctx, input: any) => {
  const failed: { id?: string; title?: string; error: string }[] = [];
  const titleById = new Map<string, string>();

  // Ids of documents already in the vault publish as-is — their paths ARE their
  // ids, and the caller owns their frontmatter. Nothing is rewritten here.
  const batch: string[] = [...(input.ids ?? [])];

  // Stage 1: write each new doc as a draft (exclusive → dup/invalid go to failed).
  for (const doc of input.documents ?? []) {
    try {
      const node = buildDraftNode(doc);
      assertValid(node);
      await ctx.storage.writeDocument(node.id, serializeDocument(node), { exclusive: true });
      batch.push(node.id);
      titleById.set(node.id, doc.title);
    } catch (err) {
      failed.push({ title: doc.title, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // An empty call is a caller bug, not an empty result — but a batch where every
  // document failed to stage is a legitimate (fully-failed) result.
  if (batch.length === 0 && failed.length === 0) {
    throw new ContextNestError(
      "context_import requires documents[] or ids[]",
      "VALIDATION_FAILED",
    );
  }

  // Stage 2: ONE bulk publish for both modes — one checkpoint + one index regen
  // for the whole batch (the O(N) path), instead of a checkpoint per document.
  let published: { id: string; version: number }[] = [];
  let checkpoint: number | null = null;
  if (batch.length > 0) {
    const result = await publishDocuments(ctx.storage, batch, {
      editedBy: ctx.actor ?? "engine",
      onProgress: ctx.onProgress,
    });
    published = result.published.map((p) => ({ id: p.id, version: p.version }));
    checkpoint = result.checkpointNumber;
    for (const f of result.failed) {
      const title = titleById.get(f.id);
      failed.push(title ? { title, error: f.error } : { id: f.id, error: f.error });
    }
  }

  return { published, failed, checkpoint };
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
  context_verify: verify,
  context_init: init,
  context_packs: packs,
  context_nests: nests,
  context_import: importDocs,
});
