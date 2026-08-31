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
import type { ContextNode, Frontmatter, SkillMeta, SourceMeta } from "../types.js";
import {
  serializeDocument,
  validateDocument,
  normalizeTags,
  normalizeStatus,
  isRejected,
  explicitStatus,
} from "../parser.js";
import { normalizeDocumentId, assertSafeDocumentId } from "../storage.js";
import { filterDocuments } from "../filters.js";
import { listVaults } from "../registry.js";
import { publishDocument, publishDocuments } from "../publish.js";
import { VersionManager } from "../versioning.js";
import { parseUri } from "../uri.js";
import { ContextNestError, RejectedDocumentError } from "../errors.js";
import {
  buildInstallManifest,
  renderSkill,
  NotASkillNodeError,
  type Harness,
  type InstallMode,
  type InstallScope,
} from "../skills.js";
import { applyTypedBlocks } from "../typed-blocks.js";
import { mapInBatches } from "../concurrency.js";
import { withVaultLock } from "../vault-lock.js";
import type { OperationContext, OperationExecutor } from "./context.js";

/** Community/engine cap on graph traversal depth (community MAX_HOPS). */
const MAX_HOPS = 10;

/** ContextNode → the wire `nodeSummary` shape. Source nodes keep their block. */
function toSummary(node: ContextNode, includeBody = false, includeFrontmatter = false) {
  return {
    id: node.id,
    title: node.frontmatter.title,
    ...(node.frontmatter.description !== undefined
      ? { description: node.frontmatter.description }
      : {}),
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

/**
 * Reject a title that carries no usable character at all — "###", "...", "   ".
 *
 * Same `\p{L}`/`\p{N}` rule as `assertSafeDocumentId`, NOT `requireSlug`: this
 * runs where the title does not derive an id, and a document created with an
 * explicit id may legitimately be titled "日本語" — which slugifies to nothing.
 */
function assertUsableTitle(title: string): void {
  if (!/[\p{L}\p{N}]/u.test(title)) {
    throw new ContextNestError(
      `Title "${title}" has no letter or number; it cannot be read back by search or wiki links`,
      "VALIDATION_FAILED",
    );
  }
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
  if (sel.id) return sanitizeId(sel.id);
  if (sel.uri) return sanitizeId(parseUri(sel.uri).path);
  // includeRetired, or a title lookup cannot see a rejected document at all and
  // falls through to the slug guess below — which quietly resolves to whatever
  // sits at that slug, or to nothing for a doc created with a custom id. The
  // ops that let a steward read and revive a retired doc need this to work.
  const docs = await ctx.storage.discoverDocuments({ includeRetired: true });
  const match = docs.find(
    (d) => d.frontmatter.title.toLowerCase() === String(sel.title).toLowerCase(),
  );
  if (match) return match.id;
  return normalizeDocumentId(requireSlug(String(sel.title)));
}

/**
 * Clean a caller-supplied id without re-rooting it.
 *
 * `normalizeDocumentId` also prepends `nodes/` to any id with no slash, which
 * silently redirects every id from a flat-layout vault (they carry no prefix)
 * to a document that does not exist. The tidying half is still wanted: callers
 * naturally build an id from a file path, and storage appends `.md` itself, so
 * an un-stripped suffix resolves to `<id>.md.md`.
 */
function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/\.md$/, "").replace(/^\/+/, "");
  assertSafeDocumentId(cleaned);
  return cleaned;
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
    trace_count: result.traces.length,
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
  // `folder` goes to discovery, not to filterDocuments: it decides which files
  // are read at all, so narrowing afterwards would save nothing.
  const docs = await ctx.storage.discoverDocuments({
    includeRetired: true,
    ...(input.folder !== undefined ? { folder: input.folder } : {}),
    ...(input.recursive !== undefined ? { recursive: input.recursive } : {}),
  });
  const kept = filterDocuments(docs, { ...input, includeRetired: input.include_retired });
  return { documents: kept.map((d) => toSummary(d, input.full === true, input.full === true)) };
};

const folders: OperationExecutor = async (ctx, input: any) => {
  // Reads directory entries only — the shape of the vault is answerable
  // without opening a single document.
  return {
    folders: await ctx.storage.listFolders({
      ...(input?.folder !== undefined ? { folder: input.folder } : {}),
      ...(input?.recursive !== undefined ? { recursive: input.recursive } : {}),
    }),
  };
};

/**
 * Collapse the `content` / `body` pair to one value.
 *
 * They name the same field: `content` is the op's parameter, `body` is what
 * the frontmatter, the legacy create_document/update_document tools, and
 * therefore most agents call it. Accepting both is what stops a caller's text
 * from going nowhere; disagreeing values are refused rather than silently
 * picking one, because either choice discards work the caller sent.
 */
function resolveContentAlias(input: { content?: unknown; body?: unknown }): string | undefined {
  const { content, body } = input;
  if (typeof content === "string" && typeof body === "string" && content !== body) {
    throw new ContextNestError(
      "`content` and `body` are aliases for the same field but were given different text — pass only one.",
      "VALIDATION_FAILED",
    );
  }
  if (typeof content === "string") return content;
  if (typeof body === "string") return body;
  return undefined;
}

/**
 * Build a fresh draft node from create/import input. Slugifies each folder
 * segment and always roots under nodes/ so the doc is discoverable
 * (normalizeDocumentId only prepends nodes/ when there is no slash — a raw
 * "gtm/deals/x" would escape the discoverable tree). Shared by `create` and
 * the bulk `import` executor so their node shape stays identical.
 */
function buildDraftNode(input: {
  id?: string;
  title: string;
  content: string;
  type?: string;
  tags?: unknown[];
  folder?: string;
  metadata?: Record<string, unknown>;
  status?: Frontmatter["status"];
  description?: string;
  trigger?: string;
  tools_required?: string[];
  output_format?: SkillMeta["output_format"];
  inputs?: SkillMeta["inputs"];
  guard_rails?: string[];
  source?: SourceMeta;
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
  const type = (input.type as Frontmatter["type"]) ?? "document";
  const frontmatter: Frontmatter = {
    title: input.title,
    type,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags ? { tags: normalizeUniqueTags(input.tags) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    status: (input.status as Frontmatter["status"]) ?? "draft",
    created_at: now,
    // A node is "updated" at birth; without this a draft carries no
    // updated_at until its first edit, and every surface renders it blank.
    updated_at: now,
  };
  // `source` and `skill` are required by one type and forbidden on the others,
  // so they cannot ride along inside `metadata` and cannot be added afterwards
  // — a source node written without its block fails every later update.
  applyTypedBlocks(frontmatter, {
    type,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.tools_required !== undefined ? { tools_required: input.tools_required } : {}),
    ...(input.output_format !== undefined ? { output_format: input.output_format } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.guard_rails !== undefined ? { guard_rails: input.guard_rails } : {}),
  });
  return { id, filePath: "", rawContent: "", frontmatter, body: input.content };
}

const create: OperationExecutor = async (ctx, input: any) => {
  const content = resolveContentAlias(input);
  if (content === undefined) {
    throw new ContextNestError(
      "A node needs a body: pass `content` (or its alias `body`).",
      "VALIDATION_FAILED",
    );
  }
  const node = buildDraftNode({ ...input, content });
  // A rejected node cannot be published — publish refuses one by design. Left
  // to fall through, the write below lands and publish then throws, stranding a
  // file on disk with no version and no history, and making the caller's retry
  // fail with DOCUMENT_ALREADY_EXISTS for a create it believes never happened.
  // Refuse before anything is written.
  const publish = node.frontmatter.status === "rejected" ? false : input.publish !== false;
  // Publish assigns the version (spec §6), so a published node must go to disk
  // WITHOUT one — pre-setting it makes the first published version 2 and leaves
  // no v1 keyframe. A draft never reaches publish, so it needs its own v1.
  if (!publish) node.frontmatter.version = 1;
  const createdStatus = node.frontmatter.status;
  assertValid(node);
  // Exclusive write: atomically refuses to clobber an existing doc (mirrors OSS
  // create_document) — no TOCTOU window, and blocks resurrecting a rejected doc
  // the way the pre-check + separate write could race.
  await ctx.storage.writeDocument(node.id, serializeDocument(node), { exclusive: true });
  // Governed callers create the node WITHOUT publishing: the write has to clear
  // review before it becomes retrievable. Still regenerate the index so the
  // draft is discoverable to the surfaces that list drafts.
  if (!publish) {
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
  // rejects (no version/checksum/history). Reviving one — moving it to some
  // OTHER status — is allowed; re-asserting `rejected` is not, or a client that
  // echoes the current status back alongside an edit silently rewrites the body
  // of a document that stays rejected.
  if (isRejected(existing) && (input.status === undefined || input.status === "rejected")) {
    throw new RejectedDocumentError(id);
  }
  const frontmatter: Frontmatter = { ...existing.frontmatter };
  // A rename leaves the id alone, so this is the id-free rule, not create's
  // slug rule: a title with no letter or number anywhere is unusable everywhere
  // it is read back (search, wiki links), but "日本語" is fine — create accepts
  // it too whenever the caller supplies the id.
  if (input.title) {
    assertUsableTitle(String(input.title));
    frontmatter.title = input.title;
  }
  if (input.status) frontmatter.status = input.status as Frontmatter["status"];
  // An empty string CLEARS the description, the same convention `metadata`
  // uses for null: over a JSON wire an absent key cannot be told apart from
  // "leave this alone", so without it a caller has no way to remove one.
  if (typeof input.description === "string") {
    if (input.description === "") delete frontmatter.description;
    else frontmatter.description = input.description;
  }
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
  // The typed blocks are settled against the node's POST-write type — the one
  // passed in this call, or the one it already carries. Without this an
  // existing type:source node has no way to gain the block rule 9 demands, and
  // every update it is ever given fails validation.
  const nextType = (input.type as Frontmatter["type"]) ?? frontmatter.type ?? "document";
  if (input.type !== undefined) frontmatter.type = nextType;
  applyTypedBlocks(frontmatter, {
    type: nextType,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.tools_required !== undefined ? { tools_required: input.tools_required } : {}),
    ...(input.output_format !== undefined ? { output_format: input.output_format } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.guard_rails !== undefined ? { guard_rails: input.guard_rails } : {}),
  });
  frontmatter.updated_at = new Date().toISOString();
  const newContent = resolveContentAlias(input);
  let body = existing.body;
  if (newContent !== undefined) body = newContent;
  if (typeof input.append === "string") body = `${body}\n${input.append}`;
  // The checksum describes the PUBLISHED body, so any body change invalidates
  // it — including one whose publish then fails, which would otherwise leave a
  // stale checksum on disk and make the next verified read cry external drift.
  // Frontmatter-only edits keep it: the checksum covers the body alone.
  if (newContent !== undefined || typeof input.append === "string") {
    delete frontmatter.checksum;
  }

  // A rejected result never publishes, whatever the caller asked for: publish
  // refuses a rejected doc, so an explicit `publish: true` alongside
  // `status: "rejected"` would write the edit and then throw, leaving the file
  // mutated and its checksum dropped. The derived default already lands here;
  // this makes it true of the explicit flag too.
  const publish =
    frontmatter.status === "rejected"
      ? false
      : (input.publish ?? !(input.status && UNPUBLISHED_STATUSES.has(input.status)));
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
          ...(config.skills?.bootstrap ? { skill_bootstrap: config.skills.bootstrap } : {}),
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

/**
 * Shared preamble for the two skill operations: load the node, and settle the
 * caller-supplied names. `server_alias` falls back to the vault's own name
 * because a caller that omits it usually configured the server under that name;
 * a wrong-but-plausible prefix is at least recognizable, where an empty one
 * renders `mcp____context_skill`.
 */
async function loadSkillNode(ctx: OperationContext, input: any) {
  const id = normalizeDocumentId(String(input.id ?? ""));
  assertSafeDocumentId(id);
  const [node, config] = await Promise.all([ctx.storage.readDocument(id), ctx.storage.readConfig()]);
  const vaultName = config?.name;
  return {
    doc: { id: node.id, frontmatter: node.frontmatter, body: node.body },
    vaultName,
    serverAlias: String(input.server_alias ?? vaultName ?? "contextnest"),
    harness: (input.harness ?? "claude-code") as Harness,
    scope: (input.scope ?? "user") as InstallScope,
    mode: (input.mode ?? "loader") as InstallMode,
  };
}

/** NotASkillNodeError carries a caller-actionable message; keep it, drop the class. */
function asValidationError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NotASkillNodeError) {
      throw new ContextNestError(err.message, "VALIDATION_FAILED");
    }
    throw err;
  }
}

const skill: OperationExecutor = async (ctx, input: any) => {
  const { doc, vaultName, serverAlias, harness, scope } = await loadSkillNode(ctx, input);
  const rendered = asValidationError(() =>
    renderSkill(doc, { harness, serverAlias, vaultName, vaultId: vaultName ?? serverAlias, scope }),
  );
  return {
    name: rendered.name,
    description: rendered.description,
    content: rendered.content,
    relative_path: rendered.relativePath,
    base: rendered.base,
    harness,
    source_path: doc.id,
    version: doc.frontmatter.version ?? null,
  };
};

const skillInstall: OperationExecutor = async (ctx, input: any) => {
  const { doc, vaultName, serverAlias, harness, scope, mode } = await loadSkillNode(ctx, input);
  return asValidationError(() =>
    buildInstallManifest(doc, {
      harness,
      serverAlias,
      vaultName,
      vaultId: vaultName ?? serverAlias,
      scope,
      mode,
    }),
  );
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

  // Stage 0: land an existing vault's files verbatim. Bounded-parallel because
  // a vault may sit on a network mount where each write is a round trip, and a
  // serial loop then costs one full latency per file.
  const incoming: { path: string; content: string }[] = input.files ?? [];
  let written = 0;
  if (incoming.length > 0) {
    await mapInBatches(incoming, async (f) => {
      try {
        await ctx.storage.writeVaultFile(f.path, f.content ?? "");
        written++;
      } catch (err) {
        failed.push({ id: f.path, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

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

  // A staging call — files written, publishing deferred to the caller's final
  // `discover` pass so a chunked upload seals ONE checkpoint, not one per chunk.
  if (input.publish === false) {
    return { published: [], failed, checkpoint: null, written };
  }

  // Stage 2 (discover): the vault itself is the input. The scan, the metadata
  // stamp and the publish-vs-hold decision all live here so a folder importer
  // does not have to walk the vault and rewrite every file before handing the
  // ids back — that pass cost a second full round trip per document.
  let held: ContextNode[] = [];
  let scanned: ContextNode[] = [];
  if (input.discover) {
    const exclude = new Set<string>(input.exclude_ids ?? []);
    // Ids the caller supplied itself, via `ids` or staged from `documents`.
    // The scan walks the whole vault, so it sees those documents too — but they
    // are the caller's, already in the batch, and carry frontmatter it chose.
    // Claiming them here would publish them under the scan's rules and stamp
    // over the author it set.
    const callerIds = new Set(batch);
    for (const doc of await ctx.storage.discoverDocuments()) {
      if (exclude.has(doc.id) || callerIds.has(doc.id)) continue;
      // Publishing is opt-in. Only a file that EXPLICITLY says it is published
      // or approved gets published; everything else is held as a draft for a
      // human to approve, including a file that states no status at all.
      //
      // Saying nothing is not consent. A vault of hand-authored notes carries
      // no governance state, and importing it should not decide on the author's
      // behalf that every note is fit to serve to an AI. Held is recoverable —
      // approve what belongs — where published-by-default is not: the exposure
      // has already happened by the time anyone reviews it.
      const status = explicitStatus(doc);
      if (status === "published" || status === "approved") scanned.push(doc);
      else held.push(doc);
    }
    batch.push(...scanned.map((d) => d.id));
  }
  // Which ids the scan claimed, so the metadata stamp below can leave a
  // caller's own staged documents alone.
  const discovered = new Set(scanned.map((d) => d.id));

  // An empty call is a caller bug, not an empty result — but a batch where every
  // document failed to stage is a legitimate (fully-failed) result, and a
  // `discover` over a folder with nothing new in it is simply done.
  if (batch.length === 0 && failed.length === 0 && !input.discover && written === 0) {
    throw new ContextNestError(
      "context_import requires documents[], ids[], files[] or discover",
      "VALIDATION_FAILED",
    );
  }

  // Stage 3: ONE bulk publish for every mode — one checkpoint + one index regen
  // for the whole batch (the O(N) path), instead of a checkpoint per document.
  let published: { id: string; version: number }[] = [];
  let checkpoint: number | null = null;
  if (batch.length > 0) {
    const result = await publishDocuments(ctx.storage, batch, {
      editedBy: ctx.actor ?? "engine",
      onProgress: ctx.onProgress,
      // The importer's metadata rides along with the publish write instead of
      // costing its own pass. Title falls back to the filename; the author is
      // the importing user, since the source's own `author:` names someone who
      // need not exist on this host.
      //
      // Scoped to the ids the SCAN found. A single call may mix modes — nothing
      // stops `discover` arriving alongside `ids`/`documents` — and a caller
      // that staged its own documents chose their frontmatter deliberately.
      // Stamping the whole batch would silently overwrite the author it set.
      frontmatter: discovered.size
        ? (node) =>
            discovered.has(node.id)
              ? {
                  title: node.frontmatter.title ?? node.id.split("/").pop() ?? node.id,
                  ...(input.author ? { author: input.author } : {}),
                }
              : null
        : undefined,
    });
    published = result.published.map((p) => ({ id: p.id, version: p.version }));
    checkpoint = result.checkpointNumber;
    for (const f of result.failed) {
      const title = titleById.get(f.id);
      failed.push(title ? { title, error: f.error } : { id: f.id, error: f.error });
    }
  }

  if (!input.discover) {
    return { published, failed, checkpoint, ...(incoming.length ? { written } : {}) };
  }

  // Stage 3b: held documents never reach the publish write, so this is their
  // only chance to be stamped. Two things must land.
  //
  // An explicit `status: draft` — a held document that states no status reads
  // back as a draft in memory (the parser's default) but says nothing on disk,
  // so anything reading the file itself, here or in another tool, is left to
  // guess. Write the status down rather than leave it implied.
  //
  // And the importing user as `author`, for the same reason the publish path
  // stamps it: the source vault's own `author:` names someone who need not
  // exist on this host, and carrying it over invents a collaborator.
  // This is the only write these documents get, so it is not extra work: it
  // replaces the far heavier publish they used to receive. A document that
  // already carries everything it needs is skipped outright, which makes a
  // re-import of an already-stamped vault free.
  await mapInBatches(held, async (doc) => {
    const authored = explicitStatus(doc);
    const stamp: Record<string, unknown> = {};

    const title = doc.frontmatter.title ?? doc.id.split("/").pop() ?? doc.id;
    if (doc.frontmatter.title !== title) stamp.title = title;
    if (input.author && doc.frontmatter.author !== input.author) stamp.author = input.author;
    // Only when the author stated nothing — an explicit `pending_review` or
    // `rejected` is theirs to keep, not ours to flatten into `draft`.
    if (authored === null) stamp.status = "draft";

    if (Object.keys(stamp).length === 0) return;
    try {
      await ctx.storage.writeDocument(
        doc.id,
        serializeDocument({ ...doc, frontmatter: { ...doc.frontmatter, ...stamp } }),
      );
    } catch (err) {
      failed.push({ id: doc.id, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Stage 4 (discover): report every document the scan owned, published or not,
  // so a governance layer can record the import without re-reading the vault.
  // A doc that failed to publish is reported at its own version, not dropped —
  // its imported history is intact and it simply stays a draft.
  const publishedVersion = new Map(published.map((p) => [p.id, p.version]));
  const asRecord = (doc: ContextNode) => {
    const version = publishedVersion.get(doc.id);
    const own = Number(doc.frontmatter.version);
    return {
      id: doc.id,
      title: doc.frontmatter.title ?? doc.id.split("/").pop() ?? doc.id,
      version: version ?? (Number.isInteger(own) && own > 0 ? own : 1),
      status: version !== undefined ? ("published" as const) : ("draft" as const),
      tags: normalizeTags(doc.frontmatter.tags) ?? [],
      content: doc.body ?? "",
    };
  };
  return {
    published,
    failed,
    checkpoint,
    ...(incoming.length ? { written } : {}),
    documents: [...scanned, ...held].map(asRecord),
  };
};

/**
 * Serialize a mutating executor on the vault's write lock. Every mutation
 * read-modify-writes the nest-level checkpoint chain; without this, concurrent
 * writers (parallel agents, two terminals, N remote clients on one server)
 * silently lose seals and break `ctx verify`. Applied at the binding so each
 * operation locks exactly once, at its outer edge.
 */
const locked =
  (executor: OperationExecutor): OperationExecutor =>
  (ctx, input) =>
    withVaultLock(ctx.storage.root, () => Promise.resolve(executor(ctx, input)));

/** name → executor for the built-in `core` namespace. */
export const CORE_EXECUTORS: Readonly<Record<string, OperationExecutor>> = Object.freeze({
  context_query: query,
  context_resolve: resolve,
  context_search: search,
  context_get: get,
  context_list: list,
  context_folders: folders,  
  context_create: locked(create),
  context_update: locked(update),
  context_publish: locked(publish),
  context_delete: locked(del),
  context_versions: versions,
  context_reconstruct: reconstruct,
  context_verify: verify,
  context_init: init,
  context_packs: packs,
  context_nests: nests,
  context_import: locked(importDocs),
  context_skill: skill,
  context_skill_install: skillInstall,
});
