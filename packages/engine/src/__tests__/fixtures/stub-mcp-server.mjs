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

// Prose in content[] + payload in structuredContent — what a nest that also
// serves chat clients emits (the community nest does exactly this).
server.tool("context_resolve", "stub resolve — structuredContent payload", {}, async () => ({
  content: [{ type: "text", text: "2 node(s):\n\n1. **Alpha**\n2. **Beta**" }],
  structuredContent: { documents: [{ id: "nodes/alpha" }, { id: "nodes/beta" }] },
}));

// The same split on the ERROR path: prose for humans, {code, message} in
// structuredContent so the client can recover the typed code.
server.tool("context_reconstruct", "stub reconstruct — structuredContent error", {}, async () => ({
  content: [{ type: "text", text: "Node not found: nodes/ghost" }],
  structuredContent: { code: "DOCUMENT_NOT_FOUND", message: "Node not found: nodes/ghost" },
  isError: true,
}));

// Slow tool for per-call timeout coverage.
server.tool("context_verify", "stub verify — never finishes in time", {}, async () => {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  return json({ valid: true, errors: [] });
});

const transport = new StdioServerTransport();
await server.connect(transport);
