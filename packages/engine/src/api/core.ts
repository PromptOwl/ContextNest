/**
 * `core` capability namespace — the read/query/list/create/update/search
 * operations. This is the near-total overlap set between the Community
 * `context_*` MCP tools and the OSS mcp-server (`read_document`, `resolve`,
 * `list_documents`, `create_document`, `update_document`, `search`).
 *
 * The `context_*` names are canonical (PRD §3); OSS legacy names are captured
 * as `aliases` so a binding can expose them as deprecated for the migration
 * window.
 *
 * Schemas compose the engine's existing domain schemas (`frontmatterSchema`,
 * `NODE_TYPES`, `STATUSES`, tag pattern) rather than duplicating them — one
 * source for both the on-disk format and the wire contract.
 */
import { z } from "zod";
import {
  NODE_TYPES,
  STATUSES,
  TAG_PATTERN,
  frontmatterSchema,
  sourceMetaSchema,
} from "../schemas.js";
import type { OperationDescriptor } from "./types.js";

const tag = z.string().regex(TAG_PATTERN);

/** A node as returned in list/query summaries (body optional/trimmed). */
const nodeSummary = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  type: z.enum(NODE_TYPES).default("document"),
  status: z.enum(STATUSES).default("draft"),
  tags: z.array(tag).optional(),
  body: z.string().optional(),
  // Whole frontmatter, on request. Summaries carry the fields a browser needs;
  // a caller that renders or gates the document needs the rest (version,
  // author, timestamps, metadata) and would otherwise re-read every file.
  frontmatter: frontmatterSchema.optional(),
  // Source nodes carry their `source` block so agents can hydrate them
  // (spec §1.9, §5). Present only for type:"source".
  source: z.record(z.unknown()).optional(),
});

/** A fully-loaded document. */
const documentPayload = z.object({
  id: z.string(),
  frontmatter: frontmatterSchema,
  body: z.string(),
  /** Exact stored bytes, frontmatter block included. Only with `include_raw`. */
  raw: z.string().optional(),
  /** Only with `verify_checksum`, and only when the live bytes have drifted. */
  pendingChange: z
    .object({
      suggestion_id: z.string(),
      detected_at: z.string(),
      source: z.string(),
      proposed_hash: z.string(),
    })
    .optional(),
});

/** Address a single node by URI, id, or title — shared by get/delete/publish/versions. */
const nodeSelectorShape = {
  uri: z.string().optional().describe("Document URI, e.g. contextnest://nodes/api-design"),
  id: z
    .string()
    .optional()
    .describe(
      "Document id / path, exactly as stored (e.g. \"nodes/api-design\"). Not re-rooted — a flat-layout vault's ids carry no nodes/ prefix.",
    ),
  title: z.string().optional().describe("Document title"),
};
/**
 * Deliberately a plain object, NOT `.refine(one of uri/id/title)`.
 *
 * A refine makes the input a ZodEffects, which has no `.shape` — and an MCP
 * tool is registered from exactly that. The SDK accepts the undefined shape and
 * publishes a tool advertising NO parameters at all, so a client cannot tell
 * what to send. `resolveId` raises the same VALIDATION_FAILED at execution
 * time, which every transport surfaces identically.
 */
const nodeSelector = z.object(nodeSelectorShape);

// ─── context_search ──────────────────────────────────────────────────────────

const searchOp: OperationDescriptor = {
  name: "context_search",
  namespace: "core",
  description:
    "Full-text keyword search across node content, titles, tags, and metadata.",
  input: z.object({
    query: z.string().min(1).describe("Search terms"),
    limit: z.number().int().positive().optional().describe("Max results"),
  }),
  output: z.object({
    results: z.array(nodeSummary.extend({ score: z.number().optional() })),
  }),
  errors: ["VALIDATION_FAILED"],
  aliases: ["search"],
};

// ─── context_query ───────────────────────────────────────────────────────────

const traversal = z.object({
  mode: z.string(),
  hops_used: z.number().int(),
  nodes_traversed: z.number().int(),
});

const queryOp: OperationDescriptor = {
  name: "context_query",
  namespace: "core",
  description:
    "Run a selector query with graph traversal. Supports #tag, type:X, [[Title]], scope:X, combined with +AND, |OR, -NOT.",
  input: z.object({
    query: z.string().min(1).describe("Selector query expression"),
    hops: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Graph traversal depth from matched nodes (default: 2)"),
    full: z
      .boolean()
      .optional()
      .describe("Force full-load mode, bypassing graph traversal"),
    include_drafts: z
      .boolean()
      .optional()
      .describe(
        "Include unpublished documents (default: published only). For authoring surfaces, where the point is to find the draft you are working on.",
      ),
  }),
  output: z.object({
    documents: z.array(nodeSummary),
    source_nodes: z.array(nodeSummary).optional(),
    traversal: traversal.optional(),
    /** Number of §9 access traces recorded by the query (consumed by `ctx query`). */
    trace_count: z.number().int().optional(),
  }),
  errors: ["VALIDATION_FAILED", "INVALID_SELECTOR", "INVALID_URI"],
  // "resolve" is the legacy OSS mcp-server tool name for THIS graph query — not
  // to be confused with the separate `context_resolve` op below (token-budgeted
  // full-content resolution).
  aliases: ["resolve"],
};

// ─── context_resolve ─────────────────────────────────────────────────────────

const resolveOp: OperationDescriptor = {
  name: "context_resolve",
  namespace: "core",
  description:
    "Full context resolution — run a selector and return complete node content within a token budget.",
  input: z.object({
    selector: z.string().min(1).describe("Selector query string"),
    max_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Approximate token budget (default: 8000)"),
    hops: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Graph traversal depth (default: 2)"),
  }),
  output: z.object({
    documents: z.array(documentPayload),
    tokens_used: z.number().int().optional(),
    truncated: z.boolean().optional(),
  }),
  errors: ["VALIDATION_FAILED", "INVALID_SELECTOR", "INVALID_URI"],
};

// ─── context_get ─────────────────────────────────────────────────────────────

const getOp: OperationDescriptor = {
  name: "context_get",
  namespace: "core",
  description:
    "Get the full content of a single node by contextnest:// URI, id, or title.",
  // Plain object, no `.refine` — see the note on nodeSelector.
  input: z.object({
    ...nodeSelectorShape,
    include_raw: z
      .boolean()
      .optional()
      .describe(
        "Also return the exact stored bytes (frontmatter block included) as `raw`, for callers that render or re-serve the file verbatim.",
      ),
    verify_checksum: z
      .boolean()
      .optional()
      .describe(
        "Detect drift on read. When the live bytes no longer match the published checksum, the last-approved content is returned with `pendingChange` describing the difference, instead of the live bytes.",
      ),
    allow_rejected: z
      .boolean()
      .optional()
      .describe(
        "Return a rejected node instead of refusing. Reading one is not the same as republishing it — surfaces that let a steward see and revive retired documents set this.",
      ),
  }),
  output: documentPayload,
  errors: [
    "VALIDATION_FAILED",
    "DOCUMENT_NOT_FOUND",
    "INVALID_DOCUMENT_ID",
    "INVALID_URI",
    "REJECTED_DOCUMENT",
  ],
  aliases: ["read_document"],
};

// ─── context_list ────────────────────────────────────────────────────────────

const listOp: OperationDescriptor = {
  name: "context_list",
  namespace: "core",
  description:
    "Browse vault contents with optional folder, type, tag, status, or limit filters.",
  input: z.object({
    // An array as well as a single value: callers that browse a family of types
    // (every runnable type, say) would otherwise have to list, then re-filter.
    type: z
      .union([z.enum(NODE_TYPES), z.array(z.enum(NODE_TYPES))])
      .optional()
      .describe("Filter by node type, or by several"),
    tag: tag.optional().describe("Filter by tag (leading # optional, case-insensitive)"),
    // Accept status synonyms (spec §1.5.1 "implementations SHOULD accept
    // synonyms and normalize"); the executor normalizes before comparing.
    status: z
      .string()
      .optional()
      .describe("Filter by status (aliases normalized). Retired nodes are hidden unless asked for."),
    limit: z.number().int().positive().optional().describe("Max nodes to return"),
    // Narrows the CRAWL, not just the result. Filtering a whole-vault listing
    // down to one folder costs exactly as much as not filtering it.
    folder: z
      .string()
      .optional()
      .describe(
        'Read only this folder, as a path relative to the vault root — the id prefix ("nodes/gtm", not "gtm"). Empty string means the vault root itself.',
      ),
    recursive: z
      .boolean()
      .optional()
      .describe(
        "With `folder`: include subfolders (default true). Pass false for one level only, so nested folders are never read.",
      ),
    include_retired: z
      .boolean()
      .optional()
      .describe(
        "Keep retired nodes even with no status filter. For governed surfaces, where a rejected node is still something its stewards act on rather than one removed from the vault.",
      ),
    full: z
      .boolean()
      .optional()
      .describe(
        "Return each node's full frontmatter and body instead of a summary. For callers that go on to render or gate the documents themselves and would otherwise have to read them all again.",
      ),
  }),
  output: z.object({
    documents: z.array(nodeSummary),
  }),
  // `folder` is a free-form string to zod, so a `..` in it clears validation
  // and is rejected by the folder normalizer instead — a consumer generating
  // handling from this list has to know that code can arrive.
  errors: ["VALIDATION_FAILED", "INVALID_DOCUMENT_ID"],
  aliases: ["list_documents"],
};

// ─── context_folders ─────────────────────────────────────────────────────────

const foldersOp: OperationDescriptor = {
  name: "context_folders",
  namespace: "core",
  description:
    "List the vault's folders and their document counts, without reading any document.",
  input: z.object({
    folder: z
      .string()
      .optional()
      .describe(
        'List folders under this one, as a path relative to the vault root — the id prefix ("nodes/gtm", not "gtm"). Omit for the whole vault.',
      ),
    recursive: z
      .boolean()
      .optional()
      .describe(
        "Include nested folders (default true). Pass false for the immediate children only.",
      ),
  }),
  output: z.object({
    folders: z.array(
      z.object({
        path: z.string().describe("Path relative to the vault root"),
        count: z
          .number()
          .int()
          .describe("Documents directly in this folder, excluding its subfolders"),
      }),
    ),
  }),
  // No alias: aliases are a migration path off tool names that already
  // existed in the wild, and nothing ever called this one.
  // INVALID_DOCUMENT_ID for the same reason as context_list — see there.
  errors: ["VALIDATION_FAILED", "INVALID_DOCUMENT_ID"],
};

// ─── context_create ──────────────────────────────────────────────────────────

const createOp: OperationDescriptor = {
  name: "context_create",
  namespace: "core",
  description: "Create a new knowledge node in the vault.",
  input: z.object({
    title: z.string().min(1).max(200).describe("Descriptive title"),
    content: z.string().optional().describe("Markdown content body"),
    // Alias, not a second field. `body` is what the legacy create_document
    // tool and the frontmatter itself call this, so agents reach for it
    // constantly; before the runtime refused unknown keys it was dropped in
    // silence and the node was written empty.
    body: z.string().optional().describe("Alias for `content` — pass one or the other, not both"),
    description: z
      .string()
      .optional()
      .describe(
        "One-line summary stored in frontmatter. Indexed for retrieval alongside title and tags, so a node without one is markedly harder to find.",
      ),
    type: z.enum(NODE_TYPES).optional().describe("Node type (default: document)"),
    tags: z.array(tag).optional().describe("Tags"),
    folder: z
      .string()
      .optional()
      .describe('Folder path under nodes/ (e.g. "gtm/deals"); segments are slugified'),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Extra frontmatter metadata (e.g. a binding's scope). Merged into frontmatter.metadata."),
    id: z
      .string()
      .optional()
      .describe(
        "Explicit document id, overriding the one derived from title + folder. For callers that mint their own ids (deterministic/system nodes) or address documents by path.",
      ),
    publish: z
      .boolean()
      .optional()
      .describe(
        "Publish on create (default true). Pass false to leave the node a draft — governed surfaces use this when a write must clear review before becoming retrievable.",
      ),
    note: z
      .string()
      .optional()
      .describe("Version-history note recorded against the publish (audit trail)."),
    status: z
      .enum(STATUSES)
      .optional()
      .describe(
        "Initial lifecycle status (default draft). Only meaningful with publish:false — publishing sets `published` regardless.",
      ),
    // These assemble the `skill` block, which is REQUIRED for type:"skill" and
    // must be absent on every other type — so they cannot ride inside
    // `metadata`. Supplying `trigger` is what creates the block.
    trigger: z.string().optional().describe("Skill trigger description (required for type:skill)"),
    tools_required: z.array(z.string()).optional().describe("Tools a skill needs to run"),
    output_format: z
      .enum(["markdown", "json", "text", "code"])
      .optional()
      .describe("Skill output format"),
    // Shape-checked by frontmatter validation rather than restated here, so the
    // skill block has exactly one authoritative schema.
    inputs: z.array(z.record(z.unknown())).optional().describe("Skill input parameters"),
    guard_rails: z.array(z.string()).optional().describe("Skill execution constraints"),
    // The `source` block's counterpart to `trigger`: REQUIRED for type:"source"
    // and forbidden on every other type, so it cannot ride inside `metadata`
    // either. Without it a source node simply could not be created.
    source: sourceMetaSchema
      .optional()
      .describe(
        'Source block (required for type:source): how an agent fetches the live data this node stands for.',
      ),
  }),
  output: z.object({
    id: z.string(),
    version: z.number().int().min(1),
    status: z.enum(STATUSES).describe("Resulting status — draft when publish:false"),
    checkpoint: z
      .number()
      .int()
      .nullable()
      .describe("Checkpoint sealing the publish, or null when created as a draft"),
  }),
  errors: ["VALIDATION_FAILED", "INVALID_DOCUMENT_ID", "DOCUMENT_ALREADY_EXISTS"],
  aliases: ["create_document"],
};

// ─── context_update ──────────────────────────────────────────────────────────

const updateOp: OperationDescriptor = {
  name: "context_update",
  namespace: "core",
  description: "Update an existing node — edit frontmatter fields and/or body, then publish.",
  // `title` is the NEW title, not a selector: every surface addresses a node by
  // id/path and sends title only to rename. Selecting by title here collided
  // with that and served no caller.
  input: z.object({
    id: z
      .string()
      .describe(
        "Id of the node to update, exactly as stored (e.g. \"nodes/api-design\"). Not re-rooted — a flat-layout vault's ids carry no nodes/ prefix.",
      ),
    title: z.string().optional().describe("New title"),
    content: z.string().optional().describe("New content (replaces body)"),
    body: z.string().optional().describe("Alias for `content` — pass one or the other, not both"),
    description: z
      .string()
      .optional()
      .describe(
        "New one-line summary for frontmatter. An empty string removes it. Indexed for retrieval alongside title and tags.",
      ),
    append: z.string().optional().describe("Content to append"),
    tags: z.array(tag).optional().describe("New tags (replaces existing)"),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe(
        "Frontmatter metadata to merge into frontmatter.metadata. A null value clears that key.",
      ),
    status: z
      .enum(STATUSES)
      .optional()
      .describe(
        "New lifecycle status. Canonical values only — normalize aliases with `normalizeStatus` before calling.",
      ),
    note: z
      .string()
      .optional()
      .describe("Version-history note recorded against the publish (audit trail)."),
    publish: z
      .boolean()
      .optional()
      .describe(
        "Publish the edit (default true). Defaults to FALSE when `status` names a non-published lifecycle value — those are metadata transitions, not content releases. An explicit value always wins.",
      ),
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Explicit version to stamp, for governed callers that assign version numbers themselves (a draft revision awaiting review). Ignored when publishing, which assigns the version.",
      ),
    // Re-typing and the typed blocks travel together: source/skill blocks are
    // required by one type and forbidden on the others, so a node can only be
    // re-typed if its block is added or dropped in the SAME call. Freezing a
    // block at creation is the trap `description` was in before this PR.
    type: z
      .enum(NODE_TYPES)
      .optional()
      .describe(
        "New node type. Converting to or from source/skill needs that type's block in the same call — `source` for a source node, `trigger` for a skill node.",
      ),
    source: sourceMetaSchema
      .optional()
      .describe(
        "Replacement source block, for a node that is (or is becoming) type:source. Replaces the block wholesale.",
      ),
    trigger: z
      .string()
      .optional()
      .describe("New skill trigger, for a node that is (or is becoming) type:skill"),
    tools_required: z.array(z.string()).optional().describe("New tools a skill needs to run"),
    output_format: z
      .enum(["markdown", "json", "text", "code"])
      .optional()
      .describe("New skill output format"),
    inputs: z.array(z.record(z.unknown())).optional().describe("New skill input parameters"),
    guard_rails: z.array(z.string()).optional().describe("New skill execution constraints"),
  }),
  output: z.object({
    id: z.string(),
    version: z.number().int().min(1),
    status: z.enum(STATUSES).describe("Resulting status — `published` unless the edit stayed a draft"),
    checkpoint: z
      .number()
      .int()
      .nullable()
      .describe("Checkpoint sealing the publish, or null when the edit did not publish"),
  }),
  errors: [
    "VALIDATION_FAILED",
    "DOCUMENT_NOT_FOUND",
    "INVALID_DOCUMENT_ID",
    "REJECTED_DOCUMENT",
  ],
  aliases: ["update_document"],
};

// ─── context_publish ─────────────────────────────────────────────────────────

const publishOp: OperationDescriptor = {
  name: "context_publish",
  namespace: "core",
  description:
    "Publish a node: bump version, compute checksum, seal a version entry + checkpoint.",
  input: z.object({
    ...nodeSelectorShape,
    note: z
      .string()
      .optional()
      .describe("Version-history note recorded against the publish (audit trail)."),
  }),
  output: z.object({
    id: z.string(),
    version: z.number().int().min(1),
    checkpoint: z.number().int().min(1),
    chain_hash: z.string().describe("Hash chaining this version to the one before it"),
  }),
  errors: [
    "VALIDATION_FAILED",
    "DOCUMENT_NOT_FOUND",
    "INVALID_DOCUMENT_ID",
    "INVALID_URI",
    "REJECTED_DOCUMENT",
  ],
  aliases: ["publish_document"],
};

// ─── context_delete ──────────────────────────────────────────────────────────

const deleteOp: OperationDescriptor = {
  name: "context_delete",
  namespace: "core",
  description: "Delete a node and its version history from the vault.",
  input: nodeSelector,
  output: z.object({
    id: z.string(),
    title: z.string().describe("Title of the deleted node, read before removal"),
    deleted: z.literal(true),
  }),
  errors: ["VALIDATION_FAILED", "DOCUMENT_NOT_FOUND", "INVALID_DOCUMENT_ID", "INVALID_URI"],
  aliases: ["delete_document"],
};

// ─── context_versions ────────────────────────────────────────────────────────

const versionEntryOut = z.object({
  version: z.number().int(),
  keyframe: z.boolean(),
  edited_by: z.string(),
  edited_at: z.string(),
  published_at: z.string().optional(),
  note: z.string().optional(),
  content_hash: z.string(),
  chain_hash: z.string(),
  /** Only present when the caller passes `include_diff`. Absent for a keyframe
   *  (a full snapshot has no patch) and for v1. */
  diff: z.string().optional().describe("Unified diff from the previous version"),
});

const versionsOp: OperationDescriptor = {
  name: "context_versions",
  namespace: "core",
  description: "Version history of a node (newest entries last).",
  // Plain object, no `.refine` — see the note on nodeSelector.
  input: z.object({
    ...nodeSelectorShape,
    // Off by default on purpose: a doc with dozens of versions would other-
    // wise return dozens of patches, which is a lot of tokens to push into an
    // agent that only asked who edited what and when.
    include_diff: z
      .boolean()
      .optional()
      .describe("Attach each version's change log (unified diff from the previous version)"),
  }),
  output: z.object({
    id: z.string(),
    keyframe_interval: z.number().int(),
    versions: z.array(versionEntryOut),
  }),
  errors: ["VALIDATION_FAILED", "DOCUMENT_NOT_FOUND", "INVALID_DOCUMENT_ID", "INVALID_URI"],
};

// context_overview is gone: it returned counts, tags and a node list, all of
// which context_init now returns alongside the vault's instructions and config.
// Two operations meant two round trips to open a vault, and a `vault_info`
// alias sitting on the one that returned none of what vault_info returns.

// ─── context_reconstruct ─────────────────────────────────────────────────────

const reconstructOp: OperationDescriptor = {
  name: "context_reconstruct",
  namespace: "core",
  description: "Reconstruct the full content of a specific past version of a node.",
  // Plain object, no `.refine` — see the note on nodeSelector.
  input: z.object({
    ...nodeSelectorShape,
    version: z.number().int().positive().describe("Version number to reconstruct"),
  }),
  output: z.object({
    id: z.string(),
    version: z.number().int(),
    content: z.string(),
  }),
  errors: [
    "VALIDATION_FAILED",
    "VERSION_NOT_FOUND",
    "RECONSTRUCTION_FAILED",
    "DOCUMENT_NOT_FOUND",
    "INVALID_DOCUMENT_ID",
    "INVALID_URI",
  ],
  aliases: ["read_version"],
};

// ─── context_verify ──────────────────────────────────────────────────────────

const verifyError = z.object({
  type: z.enum([
    "content_hash_mismatch",
    "chain_hash_mismatch",
    "cross_chain_mismatch",
    "checkpoint_hash_mismatch",
    "body_drift",
    "unreadable_history",
  ]),
  document: z.string().optional(),
  version: z.number().int().optional(),
  checkpoint: z.number().int().optional(),
  expected: z.string().nullable(),
  actual: z.string(),
});

const verifyOp: OperationDescriptor = {
  name: "context_verify",
  namespace: "core",
  description: "Verify every document and checkpoint hash chain in the vault.",
  input: z.object({}),
  output: z.object({ valid: z.boolean(), errors: z.array(verifyError) }),
  errors: ["VALIDATION_FAILED"],
  aliases: ["verify_integrity"],
};

// ─── context_init ────────────────────────────────────────────────────────────

const initOp: OperationDescriptor = {
  name: "context_init",
  namespace: "core",
  description:
    "Open a vault: its CONTEXT.md operating instructions, its configuration, and what it holds. Call this first in a session — it answers both 'how do I behave here' and 'what is here' in one round trip.",
  input: z.object({
    include_nodes: z
      .boolean()
      .optional()
      .describe(
        "Also list every node. Off by default: the counts and tags below answer most opening questions, and a large vault's node list dwarfs them.",
      ),
    limit: z.number().int().positive().optional().describe("Max nodes to list, with include_nodes"),
  }),
  output: z.object({
    context_md: z.string().nullable().describe("The vault's operating instructions, if it has any"),
    vault_path: z.string(),
    config: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        servers: z.array(z.string()).describe("Names of the MCP servers the vault declares"),
      })
      .nullable(),
    total: z.number().int(),
    by_type: z.record(z.number().int()),
    by_status: z.record(z.number().int()),
    tags: z.array(z.string()),
    nodes: z.array(nodeSummary).optional().describe("Only with include_nodes"),
  }),
  errors: ["VALIDATION_FAILED"],
  // `vault_info` returns CONTEXT.md, the config and the vault path — this
  // operation, not context_overview, which shares none of those fields.
  aliases: ["vault_info"],
};

// ─── context_packs ───────────────────────────────────────────────────────────

const packSummary = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  query: z.string().optional(),
  agent_instructions: z.string().optional(),
  // A pack's membership rules are part of the pack. Omitting them made this a
  // lossy view of what is on disk, so a caller listing packs had to read the
  // file itself to see what a pack actually selects.
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});

const packsOp: OperationDescriptor = {
  name: "context_packs",
  namespace: "core",
  description: "List the context packs defined in the vault.",
  input: z.object({}),
  output: z.object({ packs: z.array(packSummary) }),
  errors: ["VALIDATION_FAILED"],
};

// ─── context_nests ───────────────────────────────────────────────────────────

/**
 * One registered nest as returned by `context_nests`. A nest is either a local
 * vault on disk or a remote MCP endpoint, so `kind` is what a caller branches
 * on: `path`/`exists` are local-only, `transport`/`url`/`command` remote-only.
 * Reachability of a remote is deliberately absent — knowing it means probing,
 * which this op never does.
 */
const nestSummary = z.object({
  alias: z.string(),
  kind: z.enum(["local", "remote"]),
  path: z.string().optional(),
  transport: z.enum(["stdio", "http"]).optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  description: z.string().optional(),
  isDefault: z.boolean(),
  exists: z.boolean().optional(),
});

/**
 * The one `core` op that is REGISTRY-scoped rather than vault-scoped: it reads
 * the central registry (`~/.contextnest/config.yaml`) and ignores its
 * `OperationContext` entirely — there is no single vault it belongs to.
 */
const nestsOp: OperationDescriptor = {
  name: "context_nests",
  namespace: "core",
  description:
    "List every nest registered in the central registry — local vaults and remote MCP endpoints alike — with its alias, kind, endpoint, description, and whether it is the default. Use this to discover which nests exist before targeting one.",
  input: z.object({}),
  output: z.object({ nests: z.array(nestSummary) }),
  errors: ["CONFIG_ERROR", "VALIDATION_FAILED"],
};

// ─── context_import ──────────────────────────────────────────────────────────

/** One node to create in a bulk import — same shape as context_create input. */
const importDoc = z.object({
  title: z.string().min(1).max(200).describe("Descriptive title"),
  content: z.string().describe("Markdown content body"),
  type: z.enum(NODE_TYPES).optional().describe("Node type (default: document)"),
  tags: z.array(tag).optional().describe("Tags"),
  folder: z.string().optional().describe('Folder path under nodes/; segments are slugified'),
  metadata: z.record(z.unknown()).optional().describe("Extra frontmatter metadata"),
});

/** One file from an existing vault, written in exactly as given. */
const importFile = z.object({
  path: z
    .string()
    .min(1)
    .describe("Vault-relative path, e.g. `notes/api.md` or `notes/.versions/api/history.yaml`"),
  content: z.string().describe("Full file contents, frontmatter included, written verbatim"),
});

const importOp: OperationDescriptor = {
  name: "context_import",
  namespace: "core",
  description:
    "Bulk-publish many nodes in one pass (folder/batch import). Supply `documents` to create new nodes from title+content, `ids` for nodes already written into the vault, `files` to write an existing vault's files in verbatim, and/or `discover` to let the engine find and publish everything already in the vault. Publishing modes share ONE checkpoint and ONE index regeneration for the whole batch; failures are reported per-document, never aborting the rest.",
  // Every input is optional and validated in the executor rather than through
  // a refined union: `.refine()` produces a ZodEffects, which degrades to a
  // useless JSON Schema through zod-to-json-schema — and MCP publishes
  // `inputJsonSchema(op)` verbatim as the tool schema.
  input: z.object({
    documents: z
      .array(importDoc)
      .optional()
      .describe("New nodes to create and publish"),
    ids: z
      .array(z.string())
      .optional()
      .describe(
        "Ids of documents ALREADY written into the vault, published in the same batch. Ids are preserved as-is — use this when the files carry their own paths/frontmatter (folder import).",
      ),
    files: z
      .array(importFile)
      .optional()
      .describe(
        "Files from an existing vault, written in verbatim at their own relative paths. Unlike `documents` nothing is synthesized: the source's frontmatter is preserved, and non-document files (`.versions/<doc>/history.yaml`) travel too, which is what lets an imported version chain still reconstruct.",
      ),
    publish: z
      .boolean()
      .optional()
      .describe(
        "Set false to write `files` without publishing them (default true). For an upload arriving in several batches: stage every batch, then make one final `discover` call so the whole import shares ONE checkpoint instead of one per batch.",
      ),
    discover: z
      .boolean()
      .optional()
      .describe(
        "Import every document already in the vault: the engine scans, decides publish-vs-hold from each file's own frontmatter, and returns full per-document detail. For folder import, where the caller has written files in and does not want to scan or rewrite them itself. Publishing is OPT-IN — only a document whose frontmatter explicitly says `published` or `approved` is published; everything else, including a document that states no status at all, is held as a draft for a human to approve.",
      ),
    exclude_ids: z
      .array(z.string())
      .optional()
      .describe("With `discover`: ids to leave alone (already imported on an earlier run)."),
    author: z
      .string()
      .optional()
      .describe(
        "With `discover`: stamped as `author` on every imported document. The importing user, not the vault's own `author:` — which names someone who need not exist on this host.",
      ),
  }),
  output: z.object({
    published: z.array(z.object({ id: z.string(), version: z.number().int().min(1) })),
    // `title` identifies a failure from `documents`, `id` one from `ids` or
    // `files` — exactly one is set per entry.
    failed: z.array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        error: z.string(),
      }),
    ),
    /** The single checkpoint sealing the batch, or null if nothing published. */
    checkpoint: z.number().int().nullable(),
    /** `files` only: how many were written in. */
    written: z.number().int().optional(),
    /**
     * `discover` only: every document the scan took responsibility for,
     * published or held back. Carries what a governance layer needs to record
     * the import without re-reading the vault itself.
     */
    documents: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          version: z.number().int().min(1),
          status: z.enum(["published", "draft"]),
          tags: z.array(z.string()),
          content: z.string(),
        }),
      )
      .optional(),
  }),
  errors: ["VALIDATION_FAILED"],
};

/** All `core` namespace operations, in catalog order. */
export const CORE_OPERATIONS: readonly OperationDescriptor[] = [
  getOp,
  queryOp,
  resolveOp,
  listOp,
  foldersOp,
  searchOp,
  createOp,
  updateOp,
  publishOp,
  deleteOp,
  versionsOp,
  reconstructOp,
  verifyOp,
  initOp,
  packsOp,
  nestsOp,
  importOp,
];
