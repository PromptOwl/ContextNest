/**
 * Stub MCP server standing in for a GOVERNED nest, for the CLI's remote tests.
 *
 * A governed nest differs from this repo's own MCP server in the two ways
 * `ctx` has to cope with, and this stub reproduces both:
 *
 *  1. It exposes no `context_publish` and no `context_verify` — nothing is
 *     served to an agent until a steward approves it, and integrity is
 *     enforced server-side rather than as a client-verifiable hash chain.
 *     `ctx publish` is expected to land on `context_submit_review` instead.
 *  2. It answers with human-readable prose in `content` and the catalog
 *     payload alongside it in `structuredContent`.
 *
 * Spawned over stdio by remote-nests.regression.test.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "governed-nest-stub", version: "0.0.0" });

/** Prose for a chat client, payload for a machine caller. */
const split = (text, data) => ({ content: [{ type: "text", text }], structuredContent: data });

const TITLES = { "nodes/remote-note": "Remote Note" };

server.tool(
  "context_get",
  "stub get",
  { id: z.string().optional(), title: z.string().optional() },
  async ({ id }) => {
    const title = TITLES[id];
    if (!title) {
      return {
        content: [{ type: "text", text: `Node not found: ${id}` }],
        structuredContent: { code: "DOCUMENT_NOT_FOUND", message: `Node not found: ${id}` },
        isError: true,
      };
    }
    return split(`# ${title}`, { id, frontmatter: { title }, body: "stub body" });
  },
);

server.tool(
  "context_submit_review",
  "stub submit for review",
  { title: z.string(), note: z.string().optional() },
  async ({ title, note }) =>
    split(`Submitted "${title}" v3 for review (normal priority).`, {
      id: "nodes/remote-note",
      submitted: true,
      review: {
        id: "rev_stub_1",
        version: 3,
        status: "pending",
        priority: "normal",
        note: note ?? null,
      },
    }),
);

// Versions the community way: per-version `status` plus a top-level
// `approved_version`, and none of the keyframe/hash-chain fields.
server.tool("context_versions", "stub versions", { id: z.string().optional() }, async () =>
  split("# Version History", {
    id: "nodes/remote-note",
    approved_version: 2,
    versions: [
      { version: 2, status: "approved", edited_by: "steward@example.com", edited_at: "2026-08-01T00:00:00Z" },
      { version: 1, status: "superseded", edited_by: "author@example.com", edited_at: "2026-07-01T00:00:00Z" },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
