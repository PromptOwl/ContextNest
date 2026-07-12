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
  }),
  errors: ["VALIDATION_FAILED", "INVALID_URI"],
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
  errors: ["VALIDATION_FAILED", "INVALID_URI"],
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
    })
    .refine((v) => Boolean(v.uri || v.id || v.title), {
      message: "One of uri, id, or title is required",
    }),
  output: documentPayload,
  errors: ["DOCUMENT_NOT_FOUND", "INVALID_URI", "REJECTED_DOCUMENT"],
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
  errors: ["VALIDATION_FAILED"],
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
  errors: ["VALIDATION_FAILED", "DOCUMENT_NOT_FOUND", "REJECTED_DOCUMENT"],
  aliases: ["update_document"],
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
];
