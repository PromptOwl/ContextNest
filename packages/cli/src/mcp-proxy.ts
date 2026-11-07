/**
 * `ctx mcp --vault <server>/<nest>`: serve a hosted nest as a local stdio MCP
 * server.
 *
 * It lets an agent that only starts stdio servers (the Claude Code plugin's
 * `mcp-community` connection) reach a hosted nest with the key `ctx login`
 * saved: no second sign-in, no OAuth bridge. Tools are the engine's `core`
 * catalog, each run on the remote through the CLI's existing remote routing;
 * prompts and instructions are the shared ones from the engine.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContextNestError, type RemoteNestConnection } from "@promptowl/contextnest-engine";
import {
  listOperations,
  MCP_SERVER_INSTRUCTIONS,
  NEST_PROMPTS,
  renderNestPrompt,
  type OperationDescriptor,
} from "@promptowl/contextnest-engine/api";
import { openTarget, remoteTarget } from "./remote.js";
import { CLI_VERSION } from "./version.js";

/** The catalog input schema as a raw shape (refinements are re-checked by the remote). */
function inputShape(op: OperationDescriptor): z.ZodRawShape {
  let schema: z.ZodTypeAny = op.input;
  while (schema instanceof z.ZodEffects) schema = schema.innerType();
  return (schema as z.ZodObject<z.ZodRawShape>).shape;
}

/** An MCP server whose tools run on `conn`. Exported for tests. */
export function proxyServer(conn: Pick<RemoteNestConnection, "run">): McpServer {
  const server = new McpServer(
    { name: "contextnest", version: CLI_VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  // shortcut: forwards the core catalog only, not tools a hosted server adds; forward its tools/list if users need them.
  for (const op of listOperations("core")) {
    // .strict(): a misnamed parameter is refused here rather than dropped (see the MCP server's tool()).
    server.registerTool(
      op.name,
      { description: op.description, inputSchema: z.object(inputShape(op)).strict() },
      (async (args: Record<string, unknown>) => {
        try {
          const result = await conn.run(op.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          // Same structured error contract as the MCP server: `{ code, message }`.
          const code = err instanceof ContextNestError ? err.code : "INTERNAL";
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: JSON.stringify({ code, message }, null, 2) }], isError: true };
        }
      }) as ToolCallback<z.ZodObject<z.ZodRawShape, "strict">>,
    );
  }
  for (const p of NEST_PROMPTS) {
    server.registerPrompt(
      p.name,
      {
        title: p.title,
        description: p.description,
        argsSchema: Object.fromEntries(
          p.arguments.map((a) => [a.name, (a.required ? z.string() : z.string().optional()).describe(a.description)]),
        ),
      },
      (args: Record<string, string | undefined>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: renderNestPrompt(p.name, args) } }],
      }),
    );
  }
  return server;
}

/** Serve `vaultAlias` over stdio until the client disconnects. A local vault is refused. */
export async function serveRemoteNest(vaultAlias: string | undefined): Promise<void> {
  const target = remoteTarget(vaultAlias);
  if (!target) {
    throw new ContextNestError(
      "ctx mcp serves a hosted nest (--vault <server>/<nest>). For a local vault run contextnest-mcp-server.",
      "CONFIG_ERROR",
    );
  }
  const { conn } = await openTarget(target);
  const server = proxyServer(conn);
  await server.connect(new StdioServerTransport());
  // The stdio transport ignores end-of-input; close the remote so an open HTTP stream can't keep the process alive.
  process.stdin.once("end", () => void conn.close());
}
