/**
 * Stub MCP server for remote-nest client unit tests.
 *
 * Speaks just enough of the catalog contract to exercise every client path:
 * structured success, structured {code, message} errors, malformed payloads
 * (non-JSON success and error), argument echo, env inheritance, and a slow
 * tool for timeout coverage. Spawned over stdio by remote-nest.test.ts via
 * `node stub-mcp-server.mjs`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "contextnest-stub", version: "0.0.0" });

const json = (payload) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

// Structured success payload.
server.tool("context_overview", "stub overview", {}, async () =>
  json({ total: 2, by_type: { document: 2 }, by_status: { published: 2 }, tags: [], nodes: [] }),
);

// Structured error contract: isError + {code, message} JSON.
server.tool("context_get", "stub get — always missing", {}, async () => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ code: "DOCUMENT_NOT_FOUND", message: "Document not found: nodes/ghost" }),
    },
  ],
  isError: true,
}));

// Malformed SUCCESS payload (not JSON).
server.tool("context_query", "stub query — malformed success", {}, async () => ({
  content: [{ type: "text", text: "this is not json" }],
}));

// Malformed ERROR payload (isError but not JSON).
server.tool("context_list", "stub list — malformed error", {}, async () => ({
  content: [{ type: "text", text: "plain text failure" }],
  isError: true,
}));

// The MCP-native split: prose for chat clients in `content`, catalog JSON in
// `structuredContent`. The text here is deliberately unparseable, so a client
// that ignores structuredContent fails loudly instead of silently passing.
server.tool("context_resolve", "stub resolve — structured payload", {}, async () => ({
  content: [{ type: "text", text: "Resolved 2 documents for you." }],
  structuredContent: { total: 2, channel: "structuredContent" },
}));

// Same split on the error path.
server.tool("context_versions", "stub versions — structured error", {}, async () => ({
  content: [{ type: "text", text: "Sorry, I could not find that document." }],
  structuredContent: { code: "DOCUMENT_NOT_FOUND", message: "Document not found: nodes/gone" },
  isError: true,
}));
// The contextnest-community shape: human-readable PROSE in the text block,
// catalog payload in structuredContent. Parsing text first fails here.
server.tool("context_import", "stub import — prose text + structuredContent", {}, async () => ({
  content: [{ type: "text", text: "1 node(s):\n\n1. **A** [document]" }],
  structuredContent: { documents: [{ id: "nodes/a", title: "A" }] },
}));

// Same shape on the error path: prose sentence + structured {code, message}.
server.tool("context_reconstruct", "stub reconstruct — prose error + structured code", {}, async () => ({
  content: [{ type: "text", text: "Node not found: nodes/ghost" }],
  structuredContent: { code: "DOCUMENT_NOT_FOUND", message: "Node not found: nodes/ghost" },
  isError: true,
}));

// Structured output in structuredContent only, with no text mirror.
server.tool("context_nests", "stub nests — structuredContent only", {}, async () => ({
  content: [],
  structuredContent: { id: "nodes/a", title: "A" },
}));

// Nothing at all — no text, no structuredContent.
server.tool("context_publish", "stub publish — empty payload", {}, async () => ({
  content: [],
}));

// Echo the received arguments back, to pin input passthrough.
server.tool(
  "context_search",
  "stub search — echoes input",
  { query: z.string(), limit: z.number().optional() },
  async (args) => json({ received: args }),
);

// Report env vars, to pin child-env forwarding AND vault-selector stripping.
server.tool("context_packs", "stub packs — env probe", {}, async () =>
  json({
    env_probe: process.env.CN_STUB_PROBE ?? null,
    vault_selector: process.env.CONTEXTNEST_VAULT ?? null,
    vault_path_selector: process.env.CONTEXTNEST_VAULT_PATH ?? null,
  }),
);

// Slow tool for per-call timeout coverage.
server.tool("context_verify", "stub verify — never finishes in time", {}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  return json({ valid: true, errors: [] });
});

const transport = new StdioServerTransport();
await server.connect(transport);
