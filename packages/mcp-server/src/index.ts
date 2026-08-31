/**
 * @contextnest/mcp-server — MCP server for Context Nest vault access.
 * Exposes vault operations as tools for AI agents via the Model Context Protocol.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  withVaultLock,
  NestStorage,
  Resolver,
  PackLoader,
  ContextInjector,
  GraphQueryEngine,
  VersionManager,
  CheckpointManager,
  validateDocument,
  parseSelector,
  evaluate,
  parseUri,
  detectCycles,
  serializeDocument,
  parseDocument,
  publishDocument,
  stageSuggestion,
  listSuggestions,
  approveSuggestion,
  rejectSuggestion,
  isRejected,
  normalizeStatus,
  STATUS_ALIASES,
  normalizeDocumentId,
  ContextNestError,
  applyTypedBlocks,
  sourceMetaSchema,
  NODE_TYPES,
} from "@promptowl/contextnest-engine";
import type {
  ContextNode,
  Frontmatter,
  GovernanceTier,
  RbacHook,
} from "@promptowl/contextnest-engine";
import {
  createEngineApi,
  listOperations,
} from "@promptowl/contextnest-engine/api";
import type { OperationContext, OperationDescriptor } from "@promptowl/contextnest-engine/api";
import { resolveMcpVaultPath } from "./vault-resolution.js";

/** Engine operation catalog — schemas and implementations for `context_*` tools. */
const engineApi = createEngineApi();

// Resolve at module load. A bad alias / non-path arg makes resolveVaultPath
// throw; catch it here so the user gets a clean message on stderr instead of an
// unhandled Node stack trace, then exit non-zero.
let vaultPath: string;
try {
  vaultPath = resolveMcpVaultPath();
} catch (err) {
  process.stderr.write(`contextnest-mcp: ${(err as Error).message}\n`);
  process.exit(1);
}
const storage = new NestStorage(vaultPath);

// Read from package.json rather than hardcoding: this is the version MCP
// clients and directories display, and a second copy drifts from the published
// one. dist/index.js sits one level below the manifest.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const server = new McpServer({
  name: "contextnest",
  version,
});

/** Second argument every tool callback receives (request id, signal, auth, …). */
type ToolCtx = Parameters<ToolCallback<z.ZodRawShape>>[1];

/**
 * Register a tool whose input schema REFUSES keys it does not declare.
 *
 * `server.tool(name, description, rawShape, cb)` wraps the shape in a plain
 * `z.object()`, which STRIPS unknown keys — while the JSON Schema it publishes
 * to clients says `additionalProperties: false`. An agent that misnames a
 * parameter (`content` where the tool takes `body`) therefore gets a success
 * response for a write that dropped its text, detectable only by reading the
 * document back and comparing. `registerTool` takes a real ZodObject and
 * carries `.strict()` through both validation and tools/list, so the mistake
 * comes back as an input-validation error instead of silent data loss.
 */
function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (
    args: z.output<z.ZodObject<Shape>>,
    ctx: ToolCtx,
  ) => CallToolResult | Promise<CallToolResult>,
): void {
  server.registerTool(
    name,
    { description, inputSchema: z.object(shape).strict() },
    handler as ToolCallback<z.ZodObject<Shape, "strict">>,
  );
}

const regenerateIndex = () => storage.regenerateIndex();

// Permissive RBAC stub — local single-user MCP context has no real identity
// layer. All gates pass; engine still records the supplied `actor` in the
// hash chain audit trail and suggestion meta. Real deploys inject a hook
// backed by their identity provider (zone-classification-rbac-spec §4).
const permissiveRbac: RbacHook = {
  isCzar: () => true,
  canIngest: () => true,
  isDocOwner: () => true,
};

// ─── Canonical operation catalog (API Convergence Phase 2) ────────────────────
//
// Every `core` operation from the engine's canonical catalog is exposed under
// its `context_*` name with catalog-sourced description + input schema — the
// single implementation lives in the engine's executors, not here. The legacy
// OSS tool names remain registered below as deprecated aliases for the
// migration window.

const api = createEngineApi();

/** Fresh per-call execution context over the resolved vault. */
function opCtx(): OperationContext {
  return {
    storage,
    query: new GraphQueryEngine(storage),
    versions: new VersionManager(storage),
    rbac: permissiveRbac,
    actor: "mcp@contextnest.local",
  };
}

function toolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Structured error contract: every catalog-bound tool failure is an isError
 * result whose text is `{ code, message }` JSON, with `code` drawn from the
 * catalog's ERROR_CODES. This is what lets a remote `ctx` client map failures
 * back to typed engine errors instead of scraping message strings.
 */
function toolError(err: unknown) {
  const code = err instanceof ContextNestError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ code, message }, null, 2) }],
    isError: true,
  };
}

/**
 * Collapse the `body` / `content` pair to one value.
 *
 * They name the same field: `body` is this tool's parameter, `content` is what
 * `context_create`/`context_update` call it, so agents that have seen either
 * surface reach for the other's name. Disagreeing values are refused rather
 * than resolved by preference, because either choice discards text the caller
 * sent.
 */
function resolveBodyAlias(
  body: string | undefined,
  content: string | undefined,
): { ok: true; body: string | undefined } | { ok: false; error: string } {
  if (body !== undefined && content !== undefined && body !== content) {
    return {
      ok: false,
      error:
        "`body` and `content` are aliases for the same field but were given different text — pass only one.",
    };
  }
  return { ok: true, body: body ?? content };
}
/** Uniform error payload for a caller mistake (VALIDATION_FAILED). */
function validationError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, code: "VALIDATION_FAILED" }, null, 2) }],
    isError: true,
  };
}

/** Uniform error payload for an alias conflict (VALIDATION_FAILED). */
function aliasConflict(message: string) {
  return validationError(message);
}
/** Run a catalog operation and package the outcome as a tool result. */
async function runOp(name: string, input: Record<string, unknown>) {
  try {
    return toolResult(await api.run(name, input, opCtx()));
  } catch (err) {
    return toolError(err);
  }
}

/**
 * Unwrap a (possibly refined) catalog input schema to its raw object shape —
 * the SDK's tool() takes a ZodRawShape. Refinements (e.g. "one of uri/id/title
 * required") still run: api.run() re-validates against the full schema.
 * Uses _def.typeName rather than instanceof so a duplicated zod instance in
 * the dependency graph can't silently break the unwrap.
 */
function inputShape(op: OperationDescriptor): Record<string, z.ZodTypeAny> {
  let schema: any = op.input;
  while (schema?._def?.typeName === "ZodEffects") schema = schema._def.schema;
  return schema.shape as Record<string, z.ZodTypeAny>;
}

for (const op of listOperations("core")) {
  tool(op.name, op.description, inputShape(op), async (args: Record<string, unknown>) =>
    runOp(op.name, args),
  );
}

/** Description for a deprecated legacy alias, steering agents to the canonical name. */
function deprecated(canonical: string, description: string): string {
  return `DEPRECATED — use ${canonical}. ${description}`;
}

// ─── Tool: vault_info ──────────────────────────────────────────────────────────

tool("vault_info", deprecated("context_init", "It returns this plus what the vault holds. Get vault identity (CONTEXT.md) and configuration summary"), {}, async () => {
  const contextMd = await storage.readContextMd();
  const config = await storage.readConfig();

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            vault_path: vaultPath,
            context_md: contextMd || "(no CONTEXT.md found)",
            config: config
              ? {
                  name: config.name,
                  description: config.description,
                  servers: config.servers
                    ? Object.keys(config.servers)
                    : [],
                }
              : null,
          },
          null,
          2,
        ),
      },
    ],
  };
});

// ─── Tool: resolve ─────────────────────────────────────────────────────────────

tool(
  "resolve",
  deprecated(
    "context_query",
    "This has always been a graph-traversal selector query. (context_resolve is a different operation — it returns full bodies within a token budget.) Execute a selector query to find matching documents using graph traversal",
  ),
  {
    // Superset of the catalog shape: the legacy param was `selector`, the
    // canonical one is `query`. Both are accepted for the migration window;
    // the catalog op does the real validation.
    selector: z.string().optional().describe("Legacy name for `query`"),
    query: z.string().optional().describe("Selector query expression (e.g., '#engineering + type:document')"),
    hops: z.number().optional().describe("Graph traversal depth (default: 2). More hops = more context, slower. Fewer hops = faster, less context."),
    full: z.boolean().optional().describe("Force full-load mode, bypassing graph traversal (default: false)"),
  },
  async ({ selector, query, hops, full }) => {
    const input: Record<string, unknown> = { query: query ?? selector };
    if (hops !== undefined) input.hops = hops;
    if (full !== undefined) input.full = full;
    return runOp("context_query", input);
  },
);

// ─── Tool: read_document (deprecated alias of context_get) ─────────────────────

tool(
  "read_document",
  deprecated("context_get", "Read a single document by its contextnest:// URI or path"),
  {
    uri: z.string().optional().describe("Document URI (e.g., 'contextnest://nodes/api-design') or path (e.g., 'nodes/api-design')"),
    id: z.string().optional().describe("Document id / path"),
    title: z.string().optional().describe("Document title"),
    include_raw: z.boolean().optional().describe("Also return the exact on-disk bytes as `raw`"),
  },
  async ({ uri, id, title, include_raw }) => {
    const input: Record<string, unknown> = {};
    if (id) input.id = id;
    else if (uri) {
      // The legacy param accepted a plain path in `uri`; the catalog op treats
      // `uri` strictly, so route non-URIs through `id`. normalizeDocumentId
      // keeps the legacy re-rooting of a bare slug into nodes/ — context_get
      // deliberately does not re-root, but this alias always has.
      if (uri.startsWith("contextnest://")) input.uri = uri;
      else input.id = normalizeDocumentId(uri);
    }
    if (title) input.title = title;
    if (include_raw !== undefined) input.include_raw = include_raw;
    return runOp("context_get", input);
  },
);

// ─── Tool: list_documents ──────────────────────────────────────────────────────

tool(
  "list_documents",
  deprecated("context_list", "List all documents with optional filters"),
  {
    path: z
      .string()
      .optional()
      .describe(
        'List only documents under this folder, as an id prefix ("nodes/history"). Matches the folder itself and everything beneath it.',
      ),
    type: z.string().optional().describe("Filter by node type"),
    status: z
      .string()
      .optional()
      .describe(
        "Filter by status. Canonical: draft | pending_review | approved | published | rejected. Aliases (cancelled, superseded, review, submitted, active, …) are normalized before matching.",
      ),
    tag: z.string().optional().describe("Filter by tag"),
  },
  async ({ path, type, status, tag }) => {
    // includeRetired so callers can list rejected docs; default filter
    // (rejected hidden) still applies only when status filter is not set
    // to "rejected" — match below handles both cases.
    let docs = await storage.discoverDocuments({ includeRetired: true });

    if (path) {
      // Segment boundary, not a bare startsWith: "nodes/his" must not match
      // "nodes/history". A trailing slash or .md from a caller pasting a file
      // path is tolerated rather than silently matching nothing.
      const prefix = normalizeDocumentId(path.replace(/\.md$/, "").replace(/\/+$/, ""));
      docs = docs.filter((d) => d.id === prefix || d.id.startsWith(`${prefix}/`));
    }
    if (type) docs = docs.filter((d) => (d.frontmatter.type || "document") === type);
    if (status) {
      const wanted = normalizeStatus(status);
      docs = docs.filter((d) => (d.frontmatter.status || "draft") === wanted);
    } else {
      // No explicit filter — preserve default retrieval semantics (hide rejected).
      docs = docs.filter((d) => d.frontmatter.status !== "rejected");
    }
    if (tag) {
      const normalizedTag = tag.startsWith("#") ? tag : `#${tag}`;
      docs = docs.filter((d) => d.frontmatter.tags?.includes(normalizedTag));
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            docs.map((d) => ({
              id: d.id,
              title: d.frontmatter.title,
              type: d.frontmatter.type || "document",
              status: d.frontmatter.status || "draft",
              tags: d.frontmatter.tags,
            })),
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: document_format ────────────────────────────────────────────────────

tool(
  "document_format",
  "Returns the markdown document format, supported frontmatter fields, validation rules, node types, and URI scheme. Call this before creating or updating documents to ensure correct structure.",
  {},
  async () => {
    const format = {
      structure: {
        description: "Documents are markdown files with YAML frontmatter delimited by --- markers.",
        example: [
          "---",
          "title: My Document",
          "type: document",
          "status: draft",
          "tags:",
          "  - '#engineering'",
          "---",
          "",
          "# My Document",
          "",
          "Body content in GitHub Flavored Markdown.",
        ].join("\n"),
      },
      frontmatter_fields: {
        title: { required: true, type: "string", constraints: "1–200 characters" },
        description: { required: false, type: "string", constraints: "1–500 characters" },
        type: {
          required: false,
          type: "string",
          default: "document",
          values: ["document", "snippet", "glossary", "persona", "prompt", "source", "tool", "reference", "skill"],
          descriptions: {
            document: "General documentation, guides, overviews",
            snippet: "Short, reusable text fragments",
            glossary: "Term definitions",
            persona: "AI persona definitions",
            prompt: "Prompt templates",
            source: "Instructions for fetching live context (requires source block)",
            tool: "Tool documentation",
            reference: "External references",
            skill: "Reusable agent skill with trigger, inputs, steps, and guard rails (requires skill block)",
          },
        },
        tags: {
          required: false,
          type: "string[]",
          constraints: "Each tag must match: ^#?[a-zA-Z][a-zA-Z0-9_-]*$ — the # prefix is added automatically if omitted",
        },
        status: {
          required: false,
          type: "string",
          default: "draft",
          values: ["draft", "pending_review", "approved", "published", "rejected"],
          aliases: {
            description:
              "Aliases are accepted and normalized to canonical on read/write. Unknown values fall back to 'draft'.",
            // Single source of truth — engine owns the alias map. Adding a
            // new alias in schemas.ts surfaces here automatically.
            map: STATUS_ALIASES,
          },
        },
        version: { required: false, type: "integer", constraints: ">= 1, managed automatically by publish" },
        author: { required: false, type: "string" },
        created_at: { required: false, type: "string", format: "ISO 8601" },
        updated_at: { required: false, type: "string", format: "ISO 8601" },
        derived_from: { required: false, type: "string[]", constraints: "Array of contextnest:// URIs" },
        checksum: { required: false, type: "string", format: "sha256:<64 lowercase hex chars>, managed automatically" },
        metadata: { required: false, type: "object", description: "Extensible key-value metadata" },
        source: {
          required: "Only when type is 'source'; must NOT be present on other types",
          fields: {
            transport: { required: true, values: ["mcp", "rest", "cli", "function"] },
            server: { required: false, type: "string", description: "Server name matching a server in config.yaml" },
            tools: { required: true, type: "string[]", constraints: "Non-empty array of tool names" },
            depends_on: { required: false, type: "string[]", constraints: "contextnest:// URIs, must be acyclic" },
            cache_ttl: { required: false, type: "integer", constraints: "Positive integer (seconds)" },
          },
        },
        skill: {
          required: "Only when type is 'skill'; must NOT be present on other types",
          fields: {
            trigger: { required: true, type: "string", description: "Natural language description of when this skill should be invoked" },
            inputs: { required: false, type: "array", description: "Input parameters: { name, type, description, required, default }" },
            tools_required: { required: false, type: "string[]", description: "MCP tools or capabilities needed to execute" },
            output_format: { required: false, type: "string", values: ["markdown", "json", "text", "code"] },
            guard_rails: { required: false, type: "string[]", description: "Constraints or safety rules for execution" },
          },
        },
      },
      validation_rules: [
        { rule: 1, description: "Valid YAML frontmatter between --- delimiters" },
        { rule: 2, description: "title is required, 1–200 characters" },
        { rule: 3, description: "Body must be valid GitHub Flavored Markdown (spec 0.29-gfm)" },
        { rule: 4, description: "Context links must use valid contextnest:// URIs" },
        { rule: 5, description: "Tags must match pattern: ^#?[a-zA-Z][a-zA-Z0-9_-]*$" },
        { rule: 6, description: "type must be one of the 8 defined node types" },
        { rule: 7, description: "status must be one of: draft, pending_review, approved, published, rejected (aliases normalized; unknown → draft)" },
        { rule: 8, description: "checksum format: sha256:<64 lowercase hex chars>" },
        { rule: 9, description: "source block MUST be present when type is 'source'" },
        { rule: 10, description: "source.transport must be: mcp, rest, cli, or function" },
        { rule: 11, description: "source.tools must be a non-empty array of strings" },
        { rule: 12, description: "source.server should match a declared server in config" },
        { rule: 13, description: "source.depends_on entries must be valid contextnest:// URIs" },
        { rule: 16, description: "source.cache_ttl must be a positive integer if present" },
        { rule: 17, description: "source block must NOT be present on non-source types" },
      ],
      uri_scheme: {
        format: "contextnest://<path>",
        examples: [
          { uri: "contextnest://nodes/api-design", description: "Reference a document" },
          { uri: "contextnest://nodes/api-design#section", description: "Reference a section anchor" },
          { uri: "contextnest://nodes/api-design@7", description: "Pin to checkpoint 7" },
          { uri: "contextnest://tag/engineering", description: "Tag-based query" },
          { uri: "contextnest://search/auth+flow", description: "Full-text search" },
          { uri: "contextnest://folder/nodes/", description: "Folder reference (trailing slash)" },
        ],
      },
      inline_syntax: {
        context_links: "[Link Text](contextnest://path/to/doc)",
        tags: "#tag-name in body text",
        tasks: "- [ ] unchecked and - [x] checked (GFM task lists)",
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(format, null, 2),
        },
      ],
    };
  },
);

// ─── Tool: read_index ──────────────────────────────────────────────────────────

tool("read_index", "Return the context.yaml index", {}, async () => {
  const contextYaml = await storage.readContextYaml();
  return {
    content: [
      {
        type: "text" as const,
        text: contextYaml
          ? JSON.stringify(contextYaml, null, 2)
          : "No context.yaml found. Run 'ctx index' to generate it.",
      },
    ],
  };
});

// ─── Tool: read_pack ───────────────────────────────────────────────────────────

tool(
  "read_pack",
  "Resolve and return a context pack using graph traversal",
  {
    id: z.string().describe("Pack ID (e.g., 'onboarding.basics')"),
    hops: z.number().optional().describe("Graph traversal depth (default: 2)"),
  },
  async ({ id, hops }) => {
    const packs = await storage.readPacks();
    const packLoader = new PackLoader(packs);
    const pack = packLoader.get(id);

    if (!pack) {
      return { content: [{ type: "text" as const, text: `Pack "${id}" not found` }] };
    }

    const selector = pack.query || `pack:${id}`;
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query(selector, { hops: hops ?? 2 });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              pack: { id: pack.id, label: pack.label, description: pack.description },
              agent_instructions: pack.agent_instructions,
              documents: result.documents.map((d) => ({
                id: d.id,
                title: d.frontmatter.title,
                body: d.body,
              })),
              source_nodes: result.sourceNodes.map((d) => ({
                id: d.id,
                title: d.frontmatter.title,
                source: d.frontmatter.source,
                body: d.body,
              })),
              traversal: {
                mode: result.mode,
                hops_used: result.hopsUsed,
                nodes_traversed: result.nodesTraversed,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: search ──────────────────────────────────────────────────────────────

tool(
  "search",
  deprecated("context_search", "Full-text search across vault documents with graph traversal"),
  {
    query: z.string().describe("Search query"),
    hops: z.number().optional().describe("Graph traversal depth from search results (default: 2)"),
    full: z.boolean().optional().describe("Force full-load mode for body-level search (default: false)"),
  },
  async ({ query, hops, full }) => {
    const selector = `contextnest://search/${query.replace(/\s+/g, "+")}`;
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query(selector, {
      hops: hops ?? 2,
      full: full ?? false,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              documents: result.documents.map((d) => ({
                id: d.id,
                title: d.frontmatter.title,
                description: d.frontmatter.description,
                type: d.frontmatter.type || "document",
                body: d.body,
              })),
              traversal: {
                mode: result.mode,
                hops_used: result.hopsUsed,
                nodes_traversed: result.nodesTraversed,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: verify_integrity ────────────────────────────────────────────────────

tool("verify_integrity", deprecated("context_verify", "Verify integrity of all hash chains in the vault"), {}, async () => {
  const report = await storage.verifyVaultIntegrity();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(report, null, 2),
      },
    ],
  };
});

// ─── Tool: list_checkpoints ────────────────────────────────────────────────────

tool(
  "list_checkpoints",
  "List recent checkpoints",
  { limit: z.number().optional().describe("Max checkpoints to return (default 10)") },
  async ({ limit }) => {
    const cm = new CheckpointManager(storage);
    const history = await cm.loadCheckpointHistory();

    if (!history) {
      return { content: [{ type: "text" as const, text: "No checkpoints found." }] };
    }

    const n = limit ?? 10;
    const checkpoints = history.checkpoints.slice(-n);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(checkpoints, null, 2),
        },
      ],
    };
  },
);

// ─── Tool: read_version ────────────────────────────────────────────────────────

tool(
  "read_version",
  deprecated("context_reconstruct", "Read a specific version of a document"),
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    version: z.number().describe("Version number to reconstruct"),
  },
  async ({ path, version }) => {
    const id = normalizeDocumentId(path);
    const vm = new VersionManager(storage);
    const content = await vm.reconstructVersion(id, version);

    return {
      content: [
        {
          type: "text" as const,
          text: content,
        },
      ],
    };
  },
);

/**
 * The deprecated write tools below predate the operation catalog and call
 * storage/publish directly, bypassing the catalog executors' vault lock. Any
 * legacy client could therefore race a locked `context_update` and corrupt
 * the checkpoint chain. Wrapping here keeps their wire output byte-identical
 * while closing the gap; new tools go through the catalog and need nothing.
 */
const lockedHandler = <T>(fn: () => Promise<T>): Promise<T> =>
  withVaultLock(storage.root, fn);

// ─── Tool: create_document ─────────────────────────────────────────────────

tool(
  "create_document",
  deprecated(
    "context_create",
    "Create a new document in the vault with frontmatter and optional body content Kept for existing clients: it wraps the body in a heading and fills skill defaults, which context_create does not.",
  ),
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    title: z.string().describe("Document title"),
    type: z.enum(NODE_TYPES).optional().default("document").describe("Node type"),
    description: z
      .string()
      .optional()
      .describe(
        "One-line summary stored in frontmatter. Indexed for retrieval alongside title and tags, so a document without one is markedly harder to find.",
      ),
    tags: z.array(z.string()).optional().describe("Tags for the document"),
    body: z.string().optional().describe("Markdown body content"),
    content: z
      .string()
      .optional()
      .describe("Alias for `body` — pass one or the other, not both"),
    trigger: z.string().optional().describe("Skill trigger description (required when type is 'skill')"),
    tools_required: z.array(z.string()).optional().describe("Tools required for skill execution"),
    output_format: z.enum(["markdown", "json", "text", "code"]).optional().describe("Skill output format"),
    source: sourceMetaSchema
      .optional()
      .describe(
        "Source block (required when type is 'source'): how an agent fetches the live data this node stands for.",
      ),
  },
  async ({
    path,
    title,
    description,
    type,
    tags,
    body,
    content: bodyAlias,
    trigger,
    tools_required,
    output_format,
    source,
  }) => {
  lockedHandler(async () => {
    const resolvedBody = resolveBodyAlias(body, bodyAlias);
    if (!resolvedBody.ok) return aliasConflict(resolvedBody.error);

    // Mirror the CLI: bare slugs default into nodes/ so a doc created via MCP
    // lands in the same place as one created via `ctx add` (single source of
    // truth — normalizeDocumentId in the engine).
    const id = normalizeDocumentId(path);

    // Check if document already exists
    try {
      await storage.readDocument(id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Document "${id}" already exists` }) }],
        isError: true,
      };
    } catch {
      // Document doesn't exist, good to proceed
    }

    const tagList = tags ? tags.map((t) => (t.startsWith("#") ? t : `#${t}`)) : undefined;
    // version omitted — publishDocument owns version assignment (spec §6:
    // "version managed automatically by publish"). Pre-setting it caused
    // create-with-publish to land on v=2 instead of v=1.
    const frontmatter: Frontmatter = {
      title,
      type,
      ...(description !== undefined ? { description } : {}),
      status: "draft",
      created_at: new Date().toISOString(),
      ...(tagList ? { tags: tagList } : {}),
    };

    // Settle the typed blocks BEFORE anything is written. `source` and `skill`
    // are required by one type and forbidden on the others, and until now this
    // tool built a skill block but had no source equivalent — so a type:source
    // node was written with no block, published fine, and then failed every
    // update it was ever given, with no parameter able to supply the field.
    try {
      applyTypedBlocks(frontmatter, {
        type,
        ...(source !== undefined ? { source } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(tools_required !== undefined ? { tools_required } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
        defaultTrigger: `when asked to ${title.toLowerCase()}`,
      });
    } catch (err) {
      return validationError(err instanceof Error ? err.message : String(err));
    }
    // Skill defaults this tool has always filled in and context_create does not.
    if (frontmatter.skill) {
      frontmatter.skill = {
        inputs: [],
        tools_required: [],
        output_format: "markdown",
        guard_rails: [],
        ...frontmatter.skill,
      };
    }

    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter,
      body: resolvedBody.body ? `\n${resolvedBody.body}\n` : `\n# ${title}\n\n`,
      rawContent: "",
    };

    // Validate BEFORE the write, not after. Create used to skip validation
    // entirely, which is what let an invalid node reach disk in the first
    // place; checking here means a bad create leaves nothing to clean up.
    const validation = validateDocument(node);
    if (!validation.valid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Validation failed", errors: validation.errors }, null, 2),
          },
        ],
        isError: true,
      };
    }

    const content = serializeDocument(node);
    await storage.writeDocument(id, content);

    // Auto-publish: bump version, create version entry & checkpoint.
    // If publish fails after writeDocument succeeded, roll back the file
    // so the next create attempt isn't blocked by orphan state.
    let result;
    try {
      result = await publishDocument(storage, id, {
        editedBy: "mcp@contextnest.local",
        note: "Created via MCP server",
      });
    } catch (err) {
      try {
        await storage.deleteDocument(id);
      } catch {
        // best-effort cleanup; surface original publish error regardless
      }
      throw err;
    }

    await regenerateIndex();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              id: result.node.id,
              frontmatter: result.node.frontmatter,
              version: result.node.frontmatter.version,
              checkpoint: result.checkpointNumber,
              chain_hash: result.versionEntry.chain_hash,
              message: "Document created and published successfully",
            },
            null,
            2,
          ),
        },
      ],
    };
  }),
);

// ─── Tool: update_document ─────────────────────────────────────────────────

tool(
  "update_document",
  deprecated(
    "context_update",
    "Update an existing document's frontmatter fields and/or body content Kept for existing clients: it accepts status aliases and wraps the body, which context_update does not.",
  ),
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    title: z.string().optional().describe("New title"),
    description: z
      .string()
      .optional()
      .describe(
        "New one-line summary for frontmatter. An empty string removes it. Indexed for retrieval alongside title and tags.",
      ),
    tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
    status: z
      .string()
      .optional()
      .describe(
        "New status. Canonical: draft | pending_review | approved | published | rejected. Aliases like 'cancelled', 'superseded', 'active', 'archived', 'review', 'submitted', 'in_review' are accepted and normalized to canonical before storage. Unknown values fall back to 'draft'. 'rejected' retires the doc — no new published version is cut.",
      ),
    body: z.string().optional().describe("New markdown body content"),
    content: z
      .string()
      .optional()
      .describe("Alias for `body` — pass one or the other, not both"),
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
  },
  async ({
    path,
    title,
    description,
    tags,
    status,
    body,
    content: bodyAlias,
    type,
    source,
    trigger,
    tools_required,
    output_format,
  }) => {
  lockedHandler(async () => {
    const resolvedBody = resolveBodyAlias(body, bodyAlias);
    if (!resolvedBody.ok) return aliasConflict(resolvedBody.error);
    const id = normalizeDocumentId(path);
    const doc = await storage.readDocument(id);

    // Normalize caller-supplied status to canonical before any guard or
    // write. Aliases (`cancelled`, `superseded`, `review`, `active`, …)
    // collapse here so the disk store and downstream tools only ever see
    // canonical values.
    const normalizedStatus = status !== undefined ? normalizeStatus(status) : undefined;

    // Refuse content edits on rejected docs unless the caller explicitly
    // names a new status (revive to draft/pending_review/approved/published,
    // or no-op re-rejection). Mirrors the engine guard in publish.ts and
    // forces callers to declare intent before content changes land.
    if (isRejected(doc) && normalizedStatus === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: `Document "${id}" is rejected — set status (draft|pending_review|approved|published|rejected) before further updates`,
                code: "REJECTED_DOCUMENT",
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    // Update frontmatter fields
    if (title !== undefined) doc.frontmatter.title = title;
    // An empty string CLEARS the description: over a JSON wire an absent key
    // cannot be told apart from "leave this alone", so without the convention
    // a caller has no way to remove one.
    if (description !== undefined) {
      if (description === "") delete doc.frontmatter.description;
      else doc.frontmatter.description = description;
    }
    if (normalizedStatus !== undefined) doc.frontmatter.status = normalizedStatus;
    if (tags !== undefined) {
      doc.frontmatter.tags = tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
    }
    // Settle the typed blocks against the node's POST-write type — the one
    // passed in this call, or the one it already carries. Without this an
    // existing type:source node has no way to gain the block rule 9 demands,
    // and every update it is ever given fails validation.
    const nextType = type ?? doc.frontmatter.type ?? "document";
    if (type !== undefined) doc.frontmatter.type = nextType;
    try {
      applyTypedBlocks(doc.frontmatter, {
        type: nextType,
        ...(source !== undefined ? { source } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(tools_required !== undefined ? { tools_required } : {}),
        ...(output_format !== undefined ? { output_format } : {}),
      });
    } catch (err) {
      return validationError(err instanceof Error ? err.message : String(err));
    }
    doc.frontmatter.updated_at = new Date().toISOString();

    // Update body if provided
    if (resolvedBody.body !== undefined) {
      doc.body = `\n${resolvedBody.body}\n`;
    }

    // Validate before writing
    const validation = validateDocument(doc);
    if (!validation.valid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Validation failed", errors: validation.errors }, null, 2),
          },
        ],
        isError: true,
      };
    }

    const content = serializeDocument(doc);
    await storage.writeDocument(id, content);

    // Metadata-only paths — any non-published status set is treated as
    // a lifecycle transition, not a content release. Skip publishDocument
    // entirely (rejected would throw REJECTED_DOCUMENT) and don't cut a
    // new version. Only an explicit `published` or no-status update falls
    // through to the publish flow below.
    if (
      normalizedStatus === "rejected" ||
      normalizedStatus === "approved" ||
      normalizedStatus === "pending_review" ||
      normalizedStatus === "draft"
    ) {
      await regenerateIndex();
      const message =
        normalizedStatus === "rejected"
          ? "Document retired (status: rejected). No new version cut."
          : normalizedStatus === "pending_review"
            ? "Document submitted for review (status: pending_review). No new version cut."
            : normalizedStatus === "approved"
              ? "Document marked approved. No new version cut — call publish_document to release."
              : "Document reverted to draft. No new version cut.";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id,
                frontmatter: doc.frontmatter,
                message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Auto-publish: bump version, create version entry & checkpoint
    const result = await publishDocument(storage, id, {
      editedBy: "mcp@contextnest.local",
      note: "Updated via MCP server",
    });

    await regenerateIndex();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              id: result.node.id,
              frontmatter: result.node.frontmatter,
              version: result.node.frontmatter.version,
              checkpoint: result.checkpointNumber,
              chain_hash: result.versionEntry.chain_hash,
              message: "Document updated and published successfully",
            },
            null,
            2,
          ),
        },
      ],
    };
  }),
);

// ─── Tool: delete_document ─────────────────────────────────────────────────

tool(
  "delete_document",
  deprecated("context_delete", "Delete a document and its version history from the vault"),
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
  },
  async ({ path }) =>
    lockedHandler(async () => {
    const id = normalizeDocumentId(path);

    // Verify the document exists before deleting
    const doc = await storage.readDocument(id);

    await storage.deleteDocument(id);
    await regenerateIndex();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { id, title: doc.frontmatter.title, message: "Document deleted successfully" },
            null,
            2,
          ),
        },
      ],
    };
  }),
);

// ─── Tool: publish_document ────────────────────────────────────────────────

tool(
  "publish_document",
  deprecated(
    "context_publish",
    "Publish a document: bump version, compute checksum, create version entry and checkpoint",
  ),
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    author: z.string().optional().default("mcp@contextnest.local").describe("Author email"),
    note: z.string().optional().describe("Version note"),
  },
  async ({ path, author, note }) =>
    lockedHandler(async () => {
    const id = normalizeDocumentId(path);

    const result = await publishDocument(storage, id, {
      editedBy: author,
      note,
    });

    await regenerateIndex();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              id,
              version: result.node.frontmatter.version,
              checkpoint: result.checkpointNumber,
              chain_hash: result.versionEntry.chain_hash,
              message: "Document published successfully",
            },
            null,
            2,
          ),
        },
      ],
    };
  }),
);

// ─── Tool: stage_drift_suggestion ──────────────────────────────────────────

tool(
  "stage_drift_suggestion",
  "Capture an out-of-band edit (live file drifted from last-approved bytes) as a staged suggestion under _suggestions/. Does NOT modify the canonical document or hash chain. Pair with verify_integrity → approve_suggestion or reject_suggestion to resolve drift.",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    actor: z.string().optional().describe("Opaque actor identity recorded in suggestion meta. Defaults to 'local-mcp'."),
    note: z.string().optional().describe("Optional human note explaining the drift"),
  },
  async ({ path, actor, note }) => {
    const id = normalizeDocumentId(path);
    const node = await storage.readDocument(id);
    const history = await storage.readHistory(id);
    if (!history || history.versions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `No version history for "${id}" — nothing to compare against` }),
          },
        ],
        isError: true,
      };
    }
    const latest = history.versions[history.versions.length - 1];
    const approvedRaw = await new VersionManager(storage).reconstructVersion(id, latest.version);

    const zone = node.frontmatter.zone;
    const docTier: GovernanceTier = node.frontmatter.governance ?? "standard";

    const result = await stageSuggestion({
      storage,
      documentId: id,
      approvedRawContent: approvedRaw,
      proposedRawContent: node.rawContent,
      source: "out-of-band-edit",
      actor: actor ?? "local-mcp",
      zone,
      docTier,
      note,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              suggestion_id: result.meta.suggestion_id,
              document_id: result.meta.document_id,
              doc_tier: result.meta.doc_tier,
              source: result.meta.source,
              target_hash: result.meta.target_hash,
              proposed_hash: result.meta.proposed_hash,
              detected_at: result.meta.detected_at,
              patch_path: result.patchPath,
              meta_path: result.metaPath,
              message: "Drift staged. Use approve_suggestion or reject_suggestion to resolve.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: list_suggestions ────────────────────────────────────────────────

tool(
  "list_suggestions",
  "List all staged suggestions for a document",
  { path: z.string().describe("Document path (e.g., 'nodes/api-design')") },
  async ({ path }) => {
    const id = normalizeDocumentId(path);
    const metas = await listSuggestions(storage, id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { document_id: id, count: metas.length, suggestions: metas },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: approve_suggestion ──────────────────────────────────────────────

tool(
  "approve_suggestion",
  "Approve a staged suggestion: applies the patch, bumps version, writes new canonical bytes, archives the suggestion under _archive/approved/. Refuses if the chain head moved since staging (caller must re-stage).",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    suggestion_id: z.string().describe("Suggestion ID from stage_drift_suggestion or list_suggestions"),
    actor: z.string().optional().describe("Actor identity recorded as approver. Defaults to 'local-mcp'."),
    comment: z.string().optional().describe("Optional approval comment recorded in the chain event"),
  },
  async ({ path, suggestion_id, actor, comment }) => {
    const id = normalizeDocumentId(path);
    const node = await storage.readDocument(id);
    const zone = node.frontmatter.zone ?? "default";

    const result = await approveSuggestion({
      storage,
      rbac: permissiveRbac,
      documentId: id,
      actor: actor ?? "local-mcp",
      zone,
      suggestionId: suggestion_id,
      comment,
    });

    await regenerateIndex();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              document_id: id,
              version: result.versionEntry.version,
              chain_hash: result.versionEntry.chain_hash,
              chain_event_type: result.chainEvent.event_type,
              archived_at: result.archivedAt,
              message: "Suggestion approved. New version published; canonical file updated.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: reject_suggestion ───────────────────────────────────────────────

tool(
  "reject_suggestion",
  "Reject a staged suggestion: archives the patch + meta under _archive/rejected/ and emits a chain event. Canonical document and hash chain head are untouched. Rejection reason is required for audit trail.",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    suggestion_id: z.string().describe("Suggestion ID to reject"),
    reason: z.string().describe("Rejection reason (required, non-empty)"),
    actor: z.string().optional().describe("Actor identity recorded as rejector. Defaults to 'local-mcp'."),
  },
  async ({ path, suggestion_id, reason, actor }) => {
    const id = normalizeDocumentId(path);
    const node = await storage.readDocument(id);
    const zone = node.frontmatter.zone ?? "default";

    const result = await rejectSuggestion({
      storage,
      rbac: permissiveRbac,
      documentId: id,
      actor: actor ?? "local-mcp",
      zone,
      suggestionId: suggestion_id,
      reason,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              document_id: id,
              chain_event_type: result.chainEvent.event_type,
              archived_at: result.archivedAt,
              rejection_reason: reason,
              message: "Suggestion rejected. Canonical document unchanged; patch archived.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Start server ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
