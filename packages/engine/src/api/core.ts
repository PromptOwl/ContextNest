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
  // Source nodes carry their `source` block so agents can hydrate them
  // (spec §1.9, §5). Present only for type:"source".
  source: z.record(z.unknown()).optional(),
});

/** A fully-loaded document. */
const documentPayload = z.object({
  id: z.string(),
  frontmatter: frontmatterSchema,
  body: z.string(),
});

/** Address a single node by URI, id, or title — shared by get/delete/publish/versions. */
const nodeSelectorShape = {
  uri: z.string().optional().describe("Document URI, e.g. contextnest://nodes/api-design"),
  id: z.string().optional().describe("Document id / path"),
  title: z.string().optional().describe("Document title"),
};
const SELECTOR_REQUIRED = { message: "One of uri, id, or title is required" };
const hasSelector = (v: { uri?: string; id?: string; title?: string }) =>
  Boolean(v.uri || v.id || v.title);

const nodeSelector = z.object(nodeSelectorShape).refine(hasSelector, SELECTOR_REQUIRED);

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
  input: z
    .object({
      uri: z
        .string()
        .optional()
        .describe("Document URI, e.g. contextnest://nodes/api-design"),
      id: z.string().optional().describe("Document id / path"),
      title: z.string().optional().describe("Document title"),
      include_raw: z
        .boolean()
        .optional()
        .describe("Also return the document's exact on-disk bytes as `raw`"),
    })
    .refine((v) => Boolean(v.uri || v.id || v.title), {
      message: "One of uri, id, or title is required",
    }),
  output: documentPayload.extend({
    /** Exact on-disk file content (frontmatter + body). Present only with include_raw. */
    raw: z.string().optional(),
  }),
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
  description: "Browse vault contents with optional type, tag, status, or limit filters.",
  input: z.object({
    type: z.enum(NODE_TYPES).optional().describe("Filter by node type"),
    tag: tag.optional().describe("Filter by tag"),
    // Accept status synonyms (spec §1.5.1 "implementations SHOULD accept
    // synonyms and normalize"); the executor normalizes before comparing.
    status: z.string().optional().describe("Filter by status (aliases normalized)"),
    limit: z.number().int().positive().optional().describe("Max nodes to return"),
  }),
  output: z.object({
    documents: z.array(nodeSummary),
  }),
  errors: ["VALIDATION_FAILED"],
  aliases: ["list_documents"],
};

// ─── context_create ──────────────────────────────────────────────────────────

const createOp: OperationDescriptor = {
  name: "context_create",
  namespace: "core",
  description: "Create a new knowledge node in the vault.",
  input: z.object({
    id: z
      .string()
      .optional()
      .describe("Explicit document id/path (e.g. 'nodes/api-design'); overrides folder + slugified title"),
    title: z.string().min(1).max(200).describe("Descriptive title"),
    content: z.string().describe("Markdown content body"),
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
  }),
  output: z.object({
    id: z.string(),
    version: z.number().int().min(1),
  }),
  errors: ["VALIDATION_FAILED", "INVALID_DOCUMENT_ID", "DOCUMENT_ALREADY_EXISTS"],
  aliases: ["create_document"],
};

// ─── context_update ──────────────────────────────────────────────────────────

const updateOp: OperationDescriptor = {
  name: "context_update",
  namespace: "core",
  description: "Update an existing node — replace content, append, or add tags.",
  input: z
    .object({
      id: z.string().optional().describe("Id of node to update"),
      title: z.string().optional().describe("Title of node to update"),
      content: z.string().optional().describe("New content (replaces body)"),
      append: z.string().optional().describe("Content to append"),
      tags: z.array(tag).optional().describe("Tags to add"),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Extra frontmatter metadata to merge into frontmatter.metadata."),
    })
    .refine((v) => Boolean(v.id || v.title), {
      message: "One of id or title is required",
    }),
  output: z.object({
    id: z.string(),
    version: z.number().int().min(1),
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
  input: nodeSelector,
  output: z.object({
    id: z.string(),
    version: z.number().int().min(1),
    checkpoint: z.number().int().min(1),
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
  output: z.object({ id: z.string(), deleted: z.literal(true) }),
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
  input: z
    .object({
      ...nodeSelectorShape,
      // Off by default on purpose: a doc with dozens of versions would other-
      // wise return dozens of patches, which is a lot of tokens to push into an
      // agent that only asked who edited what and when.
      include_diff: z
        .boolean()
        .optional()
        .describe("Attach each version's change log (unified diff from the previous version)"),
    })
    .refine(hasSelector, SELECTOR_REQUIRED),
  output: z.object({
    id: z.string(),
    keyframe_interval: z.number().int(),
    versions: z.array(versionEntryOut),
  }),
  errors: ["VALIDATION_FAILED", "DOCUMENT_NOT_FOUND", "INVALID_DOCUMENT_ID", "INVALID_URI"],
};

// ─── context_overview ────────────────────────────────────────────────────────

const overviewOp: OperationDescriptor = {
  name: "context_overview",
  namespace: "core",
  description:
    "Vault manifest: node counts by type and status, the tag set, and a node list.",
  input: z.object({}),
  output: z.object({
    total: z.number().int(),
    by_type: z.record(z.number().int()),
    by_status: z.record(z.number().int()),
    tags: z.array(z.string()),
    nodes: z.array(nodeSummary),
  }),
  errors: ["VALIDATION_FAILED"],
  aliases: ["vault_info"],
};

// ─── context_reconstruct ─────────────────────────────────────────────────────

const reconstructOp: OperationDescriptor = {
  name: "context_reconstruct",
  namespace: "core",
  description: "Reconstruct the full content of a specific past version of a node.",
  input: z
    .object({
      uri: z.string().optional().describe("Document URI"),
      id: z.string().optional().describe("Document id / path"),
      title: z.string().optional().describe("Document title"),
      version: z.number().int().positive().describe("Version number to reconstruct"),
    })
    .refine((v) => Boolean(v.uri || v.id || v.title), {
      message: "One of uri, id, or title is required",
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
  description: "Load the vault's CONTEXT.md operating instructions (null if none).",
  input: z.object({}),
  output: z.object({ context_md: z.string().nullable() }),
  errors: ["VALIDATION_FAILED"],
};

// ─── context_packs ───────────────────────────────────────────────────────────

const packSummary = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  query: z.string().optional(),
  agent_instructions: z.string().optional(),
});

const packsOp: OperationDescriptor = {
  name: "context_packs",
  namespace: "core",
  description: "List the context packs defined in the vault.",
  input: z.object({}),
  output: z.object({ packs: z.array(packSummary) }),
  errors: ["VALIDATION_FAILED"],
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

const importOp: OperationDescriptor = {
  name: "context_import",
  namespace: "core",
  description:
    "Bulk-create and publish many nodes in one pass (folder/batch import). Seals one checkpoint for the batch; failures are reported per-document, never aborting the rest.",
  input: z.object({ documents: z.array(importDoc).min(1) }),
  output: z.object({
    created: z.array(z.object({ id: z.string(), version: z.number().int().min(1) })),
    failed: z.array(z.object({ title: z.string(), error: z.string() })),
  }),
  errors: ["VALIDATION_FAILED"],
};

/** All `core` namespace operations, in catalog order. */
export const CORE_OPERATIONS: readonly OperationDescriptor[] = [
  getOp,
  queryOp,
  resolveOp,
  listOp,
  searchOp,
  createOp,
  updateOp,
  publishOp,
  deleteOp,
  versionsOp,
  reconstructOp,
  overviewOp,
  verifyOp,
  initOp,
  packsOp,
  importOp,
];
