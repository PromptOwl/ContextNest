/**
 * @contextnest/mcp-server — MCP server for Context Nest vault access.
 * Exposes vault operations as tools for AI agents via the Model Context Protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
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
  loadGovernanceBundle,
  allowAllGovernance,
  requireRead,
  filterReadable,
  UnauthorizedActionError,
} from "@promptowl/contextnest-engine";
import type {
  ContextNode,
  Frontmatter,
  GovernanceTier,
  GovernanceHooks,
  ProvenanceOrigin,
  ProvenanceRecorder,
} from "@promptowl/contextnest-engine";
import { resolveMcpVaultPath } from "./vault-resolution.js";
import { makeAclGovernance, type AccessControl } from "./acl-governance.js";

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

const server = new McpServer({
  name: "contextnest",
  version: "0.1.0",
});

const regenerateIndex = () => storage.regenerateIndex();

// ─── Governance ────────────────────────────────────────────────────────────
//
// User-level governance is injected at deploy time via a governance module
// (CONTEXTNEST_GOVERNANCE_MODULE env var, or `governance.module` in the vault
// config — see loadGovernanceBundle). Without one, `allowAllGovernance` keeps
// every gate fully open: the local single-user MCP context has no identity
// layer, and behavior is exactly as before. The bundle is loaded in main()
// BEFORE the transport connects, so no tool call can race the load.
let governance: GovernanceHooks = allowAllGovernance;
let recorder: ProvenanceRecorder | undefined;

// Actor identity precedence: per-call `actor` tool argument (attribution
// supplied by the caller — NOT authentication) → CONTEXTNEST_ACTOR env var
// (the per-deployment identity channel for MCP) → fallback. Mutation tools
// pass their legacy attribution default ("mcp@contextnest.local") as the
// fallback so ungoverned deployments keep byte-identical audit trails.
function resolveActor(toolActor?: string, fallback = "local-mcp"): string {
  return toolActor ?? process.env.CONTEXTNEST_ACTOR ?? fallback;
}

/** Provenance origin stamped on gated engine calls: which client + tool acted. */
function mcpOrigin(tool: string): ProvenanceOrigin {
  return { client: "mcp", tool };
}

// ─── Per-query access control ───────────────────────────────────────────────
//
// Read tools accept an optional per-call requester (`asker` + `asker_role`).
// When supplied, reads are gated by the document's frontmatter `metadata.access`
// ACL evaluated against that requester (see acl-governance.ts) — the channel a
// multi-principal shared-memory agent (e.g. GateMem) needs to enforce access
// control per query, which the startup-loaded governance singleton cannot. When
// omitted, behavior is unchanged: the fixed attribution actor + base governance.
const ASKER_ARG_DESCRIPTION =
  "Requesting principal id for per-query access control (e.g. a GateMem checkpoint's asker_principal_id). When set, reads are gated by each document's metadata.access ACL (readers/roles) evaluated against this principal. Omit for the default single-principal behavior.";
const ASKER_ROLE_ARG_DESCRIPTION =
  "Requesting principal's role for per-query access control (e.g. asker_role). Matched against a document's metadata.access.roles. Only meaningful alongside 'asker'.";

// Access-control block writers can attach to a document. Persisted verbatim
// under `metadata.access` and enforced on reads by makeAclGovernance. Omitting
// it (or setting visibility "public") leaves the document readable by anyone.
const accessArgSchema = z
  .object({
    visibility: z
      .enum(["public", "private"])
      .optional()
      .describe("'private' restricts reads to the readers/roles below; 'public' (default when omitted) is open."),
    readers: z.array(z.string()).optional().describe("Principal ids permitted to read this document."),
    roles: z.array(z.string()).optional().describe("Roles permitted to read this document."),
  })
  .optional()
  .describe(
    "Per-document access control. Enforced when a reader passes 'asker'/'asker_role'. A restricted document (visibility 'private' or a non-empty readers/roles list) admits an asker whose principal id is in readers OR whose role is in roles.",
  );

/** Fold an access arg into a frontmatter metadata map, dropping empty fields. */
function mergeAccessIntoMetadata(
  metadata: Record<string, unknown> | undefined,
  access: AccessControl | undefined,
): Record<string, unknown> | undefined {
  if (access === undefined) return metadata;
  const cleaned: AccessControl = {};
  if (access.visibility !== undefined) cleaned.visibility = access.visibility;
  if (access.readers && access.readers.length > 0) cleaned.readers = access.readers;
  if (access.roles && access.roles.length > 0) cleaned.roles = access.roles;
  return { ...(metadata ?? {}), access: cleaned };
}

/**
 * Resolve the governance hooks + actor to use for a read, given an optional
 * per-call requester. With `asker`, layer frontmatter-ACL enforcement over the
 * base governance and read AS that principal; without it, keep the legacy fixed
 * attribution actor and base governance untouched.
 */
function readGovernanceFor(
  asker?: string,
  askerRole?: string,
): { gov: GovernanceHooks; actor: string } {
  if (asker === undefined) return { gov: governance, actor: resolveActor() };
  return {
    gov: makeAclGovernance(governance, storage, asker, askerRole),
    actor: asker,
  };
}

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Shared registration wrapper for governance-gated tools. A denial from the
 * engine (UnauthorizedActionError) is a per-call policy outcome, not a server
 * fault: map it to an MCP tool error (isError) so the client sees the denial
 * and the process never crashes. Every other error keeps today's behavior
 * (the SDK's CallTool handler converts thrown errors to generic tool errors).
 */
function governedTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResponse>,
): void {
  server.tool(name, description, schema, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof UnauthorizedActionError) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
      throw err;
    }
  }) as unknown as ToolCallback<S>);
}

// Shared description suffix for the optional per-call actor argument.
const ACTOR_ARG_DESCRIPTION =
  "Actor identity for governance gating and audit attribution (attribution only — NOT authentication). Precedence: this argument, then the CONTEXTNEST_ACTOR environment variable, then the local default.";

// Document-targeting tools accept `path` (legacy) or `id` (alias) — both are
// optional in the schema so either spelling validates; exactly one must be
// present at runtime. Thrown Error → SDK maps it to a tool error (isError).
const DOC_ID_ALIAS_DESCRIPTION = "Alias for 'path' — document ID (e.g., 'nodes/api-design')";
function requireDocRef(primary: string | undefined, alias: string | undefined, argName: string): string {
  const raw = primary ?? alias;
  if (!raw) throw new Error(`Missing required argument: '${argName}' (or 'id')`);
  return raw;
}

// ─── Tool: vault_info ──────────────────────────────────────────────────────────

server.tool("vault_info", "Get vault identity (CONTEXT.md) and configuration summary", {}, async () => {
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

governedTool(
  "resolve",
  "Execute a selector query to find matching documents using graph traversal",
  {
    selector: z.string().describe("Selector query expression (e.g., '#engineering + type:document')"),
    hops: z.number().optional().describe("Graph traversal depth (default: 2). More hops = more context, slower. Fewer hops = faster, less context."),
    full: z.boolean().optional().describe("Force full-load mode, bypassing graph traversal (default: false)"),
    asker: z.string().optional().describe(ASKER_ARG_DESCRIPTION),
    asker_role: z.string().optional().describe(ASKER_ROLE_ARG_DESCRIPTION),
  },
  async ({ selector, hops, full, asker, asker_role }) => {
    const { gov, actor } = readGovernanceFor(asker, asker_role);
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query(selector, {
      hops: hops ?? 2,
      full: full ?? false,
      actor,
      governance: gov,
      origin: mcpOrigin("resolve"),
      recorder,
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
                type: d.frontmatter.type || "document",
                status: d.frontmatter.status || "draft",
                tags: d.frontmatter.tags,
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

// ─── Tool: read_document ───────────────────────────────────────────────────────

governedTool(
  "read_document",
  "Read a single document by its contextnest:// URI or path",
  {
    uri: z.string().optional().describe("Document URI (e.g., 'contextnest://nodes/api-design') or path (e.g., 'nodes/api-design')"),
    id: z.string().optional().describe("Alias for 'uri' — document ID (e.g., 'nodes/api-design')"),
    asker: z.string().optional().describe(ASKER_ARG_DESCRIPTION),
    asker_role: z.string().optional().describe(ASKER_ROLE_ARG_DESCRIPTION),
  },
  async ({ uri: uriArg, id, asker, asker_role }) => {
    const uri = requireDocRef(uriArg, id, "uri");
    let docId: string;
    if (uri.startsWith("contextnest://")) {
      const parsed = parseUri(uri);
      docId = parsed.path;
    } else {
      // Mirror create_document: a bare slug resolves into nodes/ so a doc is
      // readable by the same path it was created with (normalizeDocumentId is
      // the single source of truth across every surface).
      docId = normalizeDocumentId(uri);
    }

    const { gov, actor } = readGovernanceFor(asker, asker_role);
    const doc = await storage.readDocument(docId, { governance: gov, actor });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              id: doc.id,
              frontmatter: doc.frontmatter,
              body: doc.body,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── Tool: list_documents ──────────────────────────────────────────────────────

server.tool(
  "list_documents",
  "List all documents with optional filters",
  {
    type: z.string().optional().describe("Filter by node type"),
    status: z
      .string()
      .optional()
      .describe(
        "Filter by status. Canonical: draft | pending_review | approved | published | rejected. Aliases (cancelled, superseded, review, submitted, active, …) are normalized before matching.",
      ),
    tag: z.string().optional().describe("Filter by tag"),
    asker: z.string().optional().describe(ASKER_ARG_DESCRIPTION),
    asker_role: z.string().optional().describe(ASKER_ROLE_ARG_DESCRIPTION),
  },
  async ({ type, status, tag, asker, asker_role }) => {
    // includeRetired so callers can list rejected docs; default filter
    // (rejected hidden) still applies only when status filter is not set
    // to "rejected" — match below handles both cases.
    let docs = await storage.discoverDocuments({ includeRetired: true });

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

    // User-level read gate: silently elide documents the actor cannot read
    // (deny is a filter here, never an error — mirrors GraphQueryEngine).
    const { gov, actor } = readGovernanceFor(asker, asker_role);
    docs = await filterReadable(gov, actor, docs, (d) => d.frontmatter.zone);

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

server.tool(
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
        metadata: {
          required: false,
          type: "object",
          description: "Extensible key-value metadata",
          fields: {
            access: {
              required: false,
              type: "object",
              description:
                "Per-document access control enforced on reads when the caller passes 'asker'/'asker_role' to read_document/resolve/search/list_documents/read_version. A document is public unless restricted. Restricted = visibility 'private' OR a non-empty readers/roles list; a restricted document admits an asker whose principal id is in 'readers' OR whose role is in 'roles'.",
              fields: {
                visibility: { required: false, type: "string", values: ["public", "private"], default: "public" },
                readers: { required: false, type: "string[]", description: "Principal ids allowed to read" },
                roles: { required: false, type: "string[]", description: "Roles allowed to read" },
              },
            },
          },
        },
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

server.tool("read_index", "Return the context.yaml index", {}, async () => {
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

governedTool(
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
    const result = await engine.query(selector, {
      hops: hops ?? 2,
      actor: resolveActor(),
      governance,
      origin: mcpOrigin("read_pack"),
      recorder,
    });

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

governedTool(
  "search",
  "Full-text search across vault documents with graph traversal",
  {
    query: z.string().describe("Search query"),
    hops: z.number().optional().describe("Graph traversal depth from search results (default: 2)"),
    full: z.boolean().optional().describe("Force full-load mode for body-level search (default: false)"),
    asker: z.string().optional().describe(ASKER_ARG_DESCRIPTION),
    asker_role: z.string().optional().describe(ASKER_ROLE_ARG_DESCRIPTION),
  },
  async ({ query, hops, full, asker, asker_role }) => {
    // Quote the URI so the selector lexer consumes it verbatim — a bare `+`
    // (multi-word query separator) would otherwise terminate the URI token
    // and parse as the AND operator.
    const selector = `"contextnest://search/${query.replace(/"/g, "").replace(/\s+/g, "+")}"`;
    const { gov, actor } = readGovernanceFor(asker, asker_role);
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query(selector, {
      hops: hops ?? 2,
      full: full ?? false,
      actor,
      governance: gov,
      origin: mcpOrigin("search"),
      recorder,
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

server.tool("verify_integrity", "Verify integrity of all hash chains in the vault", {}, async () => {
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

server.tool(
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

governedTool(
  "read_version",
  "Read a specific version of a document",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    version: z.number().describe("Version number to reconstruct"),
    asker: z.string().optional().describe(ASKER_ARG_DESCRIPTION),
    asker_role: z.string().optional().describe(ASKER_ROLE_ARG_DESCRIPTION),
  },
  async ({ path, version, asker, asker_role }) => {
    const id = normalizeDocumentId(path);
    // Historical bytes are as sensitive as the live document — same read gate.
    const { gov, actor } = readGovernanceFor(asker, asker_role);
    await requireRead(gov, actor, { documentId: id }, "read_version");
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

// ─── Tool: create_document ─────────────────────────────────────────────────

governedTool(
  "create_document",
  "Create a new document in the vault with frontmatter and optional body content",
  {
    path: z.string().optional().describe("Document path (e.g., 'nodes/api-design')"),
    id: z.string().optional().describe(DOC_ID_ALIAS_DESCRIPTION),
    title: z.string().describe("Document title"),
    type: z
      .enum(["document", "snippet", "glossary", "persona", "prompt", "source", "tool", "reference", "skill"])
      .optional()
      .default("document")
      .describe("Node type"),
    tags: z.array(z.string()).optional().describe("Tags for the document"),
    body: z.string().optional().default("").describe("Markdown body content"),
    trigger: z.string().optional().describe("Skill trigger description (required when type is 'skill')"),
    tools_required: z.array(z.string()).optional().describe("Tools required for skill execution"),
    output_format: z.enum(["markdown", "json", "text", "code"]).optional().describe("Skill output format"),
    access: accessArgSchema,
    actor: z.string().optional().describe(ACTOR_ARG_DESCRIPTION),
  },
  async ({ path, id: idArg, title, type, tags, body, trigger, tools_required, output_format, access, actor: actorArg }) => {
    const actor = resolveActor(actorArg, "mcp@contextnest.local");
    const docRef = requireDocRef(path, idArg, "path");
    // Mirror the CLI: bare slugs default into nodes/ so a doc created via MCP
    // lands in the same place as one created via `ctx add` (single source of
    // truth — normalizeDocumentId in the engine).
    const id = normalizeDocumentId(docRef);

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
    const metadata = mergeAccessIntoMetadata(undefined, access);
    const frontmatter: Frontmatter = {
      title,
      type,
      status: "draft",
      created_at: new Date().toISOString(),
      ...(tagList ? { tags: tagList } : {}),
      ...(metadata ? { metadata } : {}),
    };

    // Add skill block for skill nodes
    if (type === "skill") {
      frontmatter.skill = {
        trigger: trigger || `when asked to ${title.toLowerCase()}`,
        inputs: [],
        tools_required: tools_required || [],
        output_format: output_format || "markdown",
        guard_rails: [],
      };
    }

    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter,
      body: body ? `\n${body}\n` : `\n# ${title}\n\n`,
      rawContent: "",
    };

    const content = serializeDocument(node);
    await storage.writeDocument(id, content, { governance, actor, operation: "create" });

    // Auto-publish: bump version, create version entry & checkpoint.
    // If publish fails after writeDocument succeeded, roll back the file
    // so the next create attempt isn't blocked by orphan state.
    let result;
    try {
      result = await publishDocument(storage, id, {
        editedBy: actor,
        note: "Created via MCP server",
        governance,
        origin: mcpOrigin("create_document"),
        recorder,
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
  },
);

// ─── Tool: update_document ─────────────────────────────────────────────────

governedTool(
  "update_document",
  "Update an existing document's frontmatter fields and/or body content",
  {
    path: z.string().optional().describe("Document path (e.g., 'nodes/api-design')"),
    id: z.string().optional().describe(DOC_ID_ALIAS_DESCRIPTION),
    title: z.string().optional().describe("New title"),
    tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
    status: z
      .string()
      .optional()
      .describe(
        "New status. Canonical: draft | pending_review | approved | published | rejected. Aliases like 'cancelled', 'superseded', 'active', 'archived', 'review', 'submitted', 'in_review' are accepted and normalized to canonical before storage. Unknown values fall back to 'draft'. 'rejected' retires the doc — no new published version is cut.",
      ),
    body: z.string().optional().describe("New markdown body content"),
    access: accessArgSchema,
    actor: z.string().optional().describe(ACTOR_ARG_DESCRIPTION),
  },
  async ({ path, id: idArg, title, tags, status, body, access, actor: actorArg }) => {
    const actor = resolveActor(actorArg, "mcp@contextnest.local");
    const id = normalizeDocumentId(requireDocRef(path, idArg, "path"));
    const doc = await storage.readDocument(id, { governance, actor });

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
    if (normalizedStatus !== undefined) doc.frontmatter.status = normalizedStatus;
    if (tags !== undefined) {
      doc.frontmatter.tags = tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
    }
    if (access !== undefined) {
      doc.frontmatter.metadata = mergeAccessIntoMetadata(doc.frontmatter.metadata, access);
    }
    doc.frontmatter.updated_at = new Date().toISOString();

    // Update body if provided
    if (body !== undefined) {
      doc.body = `\n${body}\n`;
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
    await storage.writeDocument(id, content, { governance, actor, operation: "update" });

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
      editedBy: actor,
      note: "Updated via MCP server",
      governance,
      origin: mcpOrigin("update_document"),
      recorder,
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
  },
);

// ─── Tool: delete_document ─────────────────────────────────────────────────

governedTool(
  "delete_document",
  "Delete a document and its version history from the vault",
  {
    path: z.string().optional().describe("Document path (e.g., 'nodes/api-design')"),
    id: z.string().optional().describe(DOC_ID_ALIAS_DESCRIPTION),
    actor: z.string().optional().describe(ACTOR_ARG_DESCRIPTION),
  },
  async ({ path, id: idArg, actor: actorArg }) => {
    const actor = resolveActor(actorArg);
    const id = normalizeDocumentId(requireDocRef(path, idArg, "path"));

    // Verify the document exists before deleting
    const doc = await storage.readDocument(id, { governance, actor });

    await storage.deleteDocument(id, { governance, actor });
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
  },
);

// ─── Tool: publish_document ────────────────────────────────────────────────

governedTool(
  "publish_document",
  "Publish a document: bump version, compute checksum, create version entry and checkpoint",
  {
    path: z.string().optional().describe("Document path (e.g., 'nodes/api-design')"),
    id: z.string().optional().describe(DOC_ID_ALIAS_DESCRIPTION),
    author: z.string().optional().default("mcp@contextnest.local").describe("Author email"),
    note: z.string().optional().describe("Version note"),
    actor: z.string().optional().describe(`${ACTOR_ARG_DESCRIPTION} Takes precedence over 'author' for version attribution.`),
  },
  async ({ path, id: idArg, author, note, actor: actorArg }) => {
    const id = normalizeDocumentId(requireDocRef(path, idArg, "path"));
    // Legacy `author` (with its default) stays the attribution fallback so
    // ungoverned deployments record exactly what they always did.
    const actor = resolveActor(actorArg, author);

    const result = await publishDocument(storage, id, {
      editedBy: actor,
      note,
      governance,
      origin: mcpOrigin("publish_document"),
      recorder,
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
  },
);

// ─── Tool: stage_drift_suggestion ──────────────────────────────────────────

governedTool(
  "stage_drift_suggestion",
  "Capture an out-of-band edit (live file drifted from last-approved bytes) as a staged suggestion under _suggestions/. Does NOT modify the canonical document or hash chain. Pair with verify_integrity → approve_suggestion or reject_suggestion to resolve drift.",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    actor: z.string().optional().describe(`Opaque actor identity recorded in suggestion meta. ${ACTOR_ARG_DESCRIPTION}`),
    note: z.string().optional().describe("Optional human note explaining the drift"),
  },
  async ({ path, actor: actorArg, note }) => {
    const actor = resolveActor(actorArg);
    const id = normalizeDocumentId(path);
    const node = await storage.readDocument(id, { governance, actor });
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
      actor,
      zone,
      docTier,
      note,
      governance,
      origin: mcpOrigin("stage_drift_suggestion"),
      recorder,
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

server.tool(
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

governedTool(
  "approve_suggestion",
  "Approve a staged suggestion: applies the patch, bumps version, writes new canonical bytes, archives the suggestion under _archive/approved/. Refuses if the chain head moved since staging (caller must re-stage).",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    suggestion_id: z.string().describe("Suggestion ID from stage_drift_suggestion or list_suggestions"),
    actor: z.string().optional().describe(`Actor identity recorded as approver. ${ACTOR_ARG_DESCRIPTION}`),
    comment: z.string().optional().describe("Optional approval comment recorded in the chain event"),
  },
  async ({ path, suggestion_id, actor: actorArg, comment }) => {
    const actor = resolveActor(actorArg);
    const id = normalizeDocumentId(path);
    const node = await storage.readDocument(id, { governance, actor });
    const zone = node.frontmatter.zone ?? "default";

    const result = await approveSuggestion({
      storage,
      rbac: governance,
      documentId: id,
      actor,
      zone,
      suggestionId: suggestion_id,
      comment,
      origin: mcpOrigin("approve_suggestion"),
      recorder,
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

governedTool(
  "reject_suggestion",
  "Reject a staged suggestion: archives the patch + meta under _archive/rejected/ and emits a chain event. Canonical document and hash chain head are untouched. Rejection reason is required for audit trail.",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    suggestion_id: z.string().describe("Suggestion ID to reject"),
    reason: z.string().describe("Rejection reason (required, non-empty)"),
    actor: z.string().optional().describe(`Actor identity recorded as rejector. ${ACTOR_ARG_DESCRIPTION}`),
  },
  async ({ path, suggestion_id, reason, actor: actorArg }) => {
    const actor = resolveActor(actorArg);
    const id = normalizeDocumentId(path);
    const node = await storage.readDocument(id, { governance, actor });
    const zone = node.frontmatter.zone ?? "default";

    const result = await rejectSuggestion({
      storage,
      rbac: governance,
      documentId: id,
      actor,
      zone,
      suggestionId: suggestion_id,
      reason,
      origin: mcpOrigin("reject_suggestion"),
      recorder,
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
  // Load the deployment's governance module (if any) BEFORE the transport
  // connects so no tool call can race an open gate. Nothing configured →
  // null → fully open (exact legacy behavior). A configured-but-broken
  // module throws ConfigError, which propagates to the catch below and
  // crashes startup loudly — misconfigured governance must never fall open.
  const bundle = await loadGovernanceBundle({ vaultPath, env: process.env });
  governance = bundle?.hooks ?? allowAllGovernance;
  recorder = bundle?.recorder;

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
