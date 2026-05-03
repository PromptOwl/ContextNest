/**
 * @contextnest/mcp-server — MCP server for Context Nest vault access.
 * Exposes vault operations as tools for AI agents via the Model Context Protocol.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
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
  verifyDocumentChain,
  verifyCheckpointChain,
  generateContextYaml,
  generateAgentConfigs,
  mergeAgentConfig,
  parseUri,
  detectCycles,
  serializeDocument,
  parseDocument,
  publishDocument,
  generateIndexMd,
} from "@promptowl/contextnest-engine";
import type { ContextNode, Frontmatter } from "@promptowl/contextnest-engine";

// Resolve vault path from env or args
const vaultPath = process.env.CONTEXTNEST_VAULT_PATH || process.argv[2] || process.cwd();
const storage = new NestStorage(vaultPath);

const server = new McpServer({
  name: "contextnest",
  version: "0.1.0",
});

/**
 * Regenerate context.yaml and INDEX.md files after vault mutations.
 */
async function regenerateIndex(): Promise<void> {
  const docs = await storage.discoverDocuments();
  const config = await storage.readConfig();
  const checkpointHistory = await storage.readCheckpointHistory();
  const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
  const published = docs.filter((d) => d.frontmatter.status === "published");
  const packs = await storage.readPacks();

  const contextYaml = generateContextYaml(published, config, latestCheckpoint);
  await storage.writeContextYaml(contextYaml);

  // Generate INDEX.md for each folder
  const folders = new Map<string, ContextNode[]>();
  for (const doc of docs) {
    const parts = doc.id.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(doc);
  }

  for (const [folder, folderDocs] of folders) {
    if (folder === ".") continue;
    const title = folder.split("/").pop()!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const indexMd = generateIndexMd(folder, title, folderDocs);
    await storage.writeIndexMd(folder, indexMd);
  }

  // Generate agent config files (CLAUDE.md, GEMINI.md, .cursorrules, etc.)
  const hasMcpServer = !!(config?.servers && Object.keys(config.servers).length > 0);
  const agentConfigs = generateAgentConfigs({
    config,
    contextYaml,
    packs,
    hasMcpServer,
  });

  for (const file of agentConfigs) {
    const filePath = join(vaultPath, file.path);
    await mkdir(dirname(filePath), { recursive: true });

    let existing: string | null = null;
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    const merged = mergeAgentConfig(existing, file.content);
    await writeFile(filePath, merged, "utf-8");
  }
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

server.tool(
  "resolve",
  "Execute a selector query to find matching documents using graph traversal",
  {
    selector: z.string().describe("Selector query expression (e.g., '#engineering + type:document')"),
    hops: z.number().optional().describe("Graph traversal depth (default: 2). More hops = more context, slower. Fewer hops = faster, less context."),
    full: z.boolean().optional().describe("Force full-load mode, bypassing graph traversal (default: false)"),
  },
  async ({ selector, hops, full }) => {
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

server.tool(
  "read_document",
  "Read a single document by its contextnest:// URI or path",
  { uri: z.string().describe("Document URI (e.g., 'contextnest://nodes/api-design') or path (e.g., 'nodes/api-design')") },
  async ({ uri }) => {
    let docId: string;
    if (uri.startsWith("contextnest://")) {
      const parsed = parseUri(uri);
      docId = parsed.path;
    } else {
      docId = uri.replace(/\.md$/, "");
    }

    const doc = await storage.readDocument(docId);
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
    status: z.string().optional().describe("Filter by status (draft/published)"),
    tag: z.string().optional().describe("Filter by tag"),
  },
  async ({ type, status, tag }) => {
    let docs = await storage.discoverDocuments();

    if (type) docs = docs.filter((d) => (d.frontmatter.type || "document") === type);
    if (status) docs = docs.filter((d) => (d.frontmatter.status || "draft") === status);
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
        status: { required: false, type: "string", default: "draft", values: ["draft", "published"] },
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
        { rule: 7, description: "status must be 'draft' or 'published'" },
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

server.tool(
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

server.tool(
  "search",
  "Full-text search across vault documents with graph traversal",
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

server.tool("verify_integrity", "Verify integrity of all hash chains in the vault", {}, async () => {
  const allHistories = await storage.findAllHistories();
  const checkpointHistory = await storage.readCheckpointHistory();
  const errors: any[] = [];

  for (const [docId, history] of allHistories) {
    const report = verifyDocumentChain(docId, history, (_version) => null);
    if (!report.valid) errors.push(...report.errors);
  }

  if (checkpointHistory) {
    const report = verifyCheckpointChain(checkpointHistory.checkpoints, allHistories);
    if (!report.valid) errors.push(...report.errors);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ valid: errors.length === 0, errors }, null, 2),
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

server.tool(
  "read_version",
  "Read a specific version of a document",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    version: z.number().describe("Version number to reconstruct"),
  },
  async ({ path, version }) => {
    const id = path.replace(/\.md$/, "");
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

server.tool(
  "create_document",
  "Create a new document in the vault with frontmatter and optional body content",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
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
  },
  async ({ path, title, type, tags, body, trigger, tools_required, output_format }) => {
    const id = path.replace(/\.md$/, "");

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
    const frontmatter: Frontmatter = {
      title,
      type,
      status: "draft",
      version: 1,
      created_at: new Date().toISOString(),
      ...(tagList ? { tags: tagList } : {}),
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
    await storage.writeDocument(id, content);

    // Auto-publish: bump version, create version entry & checkpoint
    const result = await publishDocument(storage, id, {
      editedBy: "mcp@contextnest.local",
      note: "Created via MCP server",
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

server.tool(
  "update_document",
  "Update an existing document's frontmatter fields and/or body content",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    title: z.string().optional().describe("New title"),
    tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
    status: z.enum(["draft", "published"]).optional().describe("New status"),
    body: z.string().optional().describe("New markdown body content"),
  },
  async ({ path, title, tags, status, body }) => {
    const id = path.replace(/\.md$/, "");
    const doc = await storage.readDocument(id);

    // Update frontmatter fields
    if (title !== undefined) doc.frontmatter.title = title;
    if (status !== undefined) doc.frontmatter.status = status;
    if (tags !== undefined) {
      doc.frontmatter.tags = tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
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
    await storage.writeDocument(id, content);

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
  },
);

// ─── Tool: delete_document ─────────────────────────────────────────────────

server.tool(
  "delete_document",
  "Delete a document and its version history from the vault",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
  },
  async ({ path }) => {
    const id = path.replace(/\.md$/, "");

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
  },
);

// ─── Tool: publish_document ────────────────────────────────────────────────

server.tool(
  "publish_document",
  "Publish a document: bump version, compute checksum, create version entry and checkpoint",
  {
    path: z.string().describe("Document path (e.g., 'nodes/api-design')"),
    author: z.string().optional().default("mcp@contextnest.local").describe("Author email"),
    note: z.string().optional().describe("Version note"),
  },
  async ({ path, author, note }) => {
    const id = path.replace(/\.md$/, "");

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
