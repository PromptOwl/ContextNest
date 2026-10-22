/**
 * Stub MCP server standing in for a Community nest that EXPOSES `context_move`,
 * for the CLI's move-under-review regression (MOVE-03).
 *
 * This repo's own MCP server has no `context_move` at all, so it can only prove
 * the "tool not found" refusal. A hosted Community nest does expose it, and
 * moving a `pending_review` document there fails server-side — the move result
 * can't be serialized and the nest answers with the YAML dump error
 * "unacceptable kind of an object to dump [object Undefined]" (PromptOwl
 * contextnest-community #191). This stub reproduces exactly that surface:
 *
 *  - `nodes/published-doc` moves cleanly and returns the catalog payload
 *    (`{id, previous_id}`), so the move route itself is proven reachable.
 *  - `nodes/under-review` answers `isError` with the #191 dump message, so the
 *    CLI's relay of a real server-side move failure can be pinned.
 *  - `nodes/empty-move` answers success but with an undefined payload, pinning
 *    that the CLI never dereferences a missing result into a raw TypeError.
 *
 * Spawned over stdio by remote-nests.regression.test.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "move-under-review-stub", version: "0.0.0" });

/** Prose for a chat client, payload for a machine caller. */
const split = (text, data) => ({ content: [{ type: "text", text }], structuredContent: data });

const TITLES = {
  "nodes/published-doc": "Published Doc",
  "nodes/under-review": "Under Review Doc",
  "nodes/empty-move": "Empty Move Doc",
};

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
  "context_move",
  "stub move",
  { id: z.string(), folder: z.string() },
  async ({ id, folder }) => {
    if (id === "nodes/under-review") {
      // #191: moving a pending_review doc blows up on the server-side YAML dump.
      return {
        content: [{ type: "text", text: "unacceptable kind of an object to dump [object Undefined]" }],
        structuredContent: {
          code: "INTERNAL",
          message: "unacceptable kind of an object to dump [object Undefined]",
        },
        isError: true,
      };
    }
    if (id === "nodes/empty-move") {
      // Success envelope, but nothing came back to dump (undefined payload).
      return split("Moved.", undefined);
    }
    const previous_id = id;
    const slug = id.split("/").pop();
    const newId = folder ? `${folder}/${slug}` : slug;
    return split(`Moved ${previous_id} -> ${newId}`, { id: newId, previous_id });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
