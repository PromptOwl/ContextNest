/**
 * Stub MCP server standing in for a hosted (Community) nest that supports the
 * task log, for J26 (`ctx task log`). It exists because `context_task_log` is a
 * hosted-only operation — the open-source engine and this repo's own MCP server
 * do not serve it — so a journey that drives `ctx task log` end-to-end has to
 * talk to a server that does.
 *
 * `ctx task log` needs two things from the server, both satisfied here:
 *   1. `requireTaskSupport` checks the server ADVERTISES `context_task_log` (the
 *      tool is the capability signal) before it writes anything — so the tool
 *      appears in `tools/list`.
 *   2. It calls `context_task_log` and renders `{ id, entry, claim?, assignee? }`.
 *
 * Zero dependencies on purpose: every other tests/e2e-pkg mock is dependency-free
 * so it resolves under pnpm's isolated node_modules, where the MCP SDK does not.
 * This hand-rolls the slice of the MCP stdio protocol the CLI's client drives:
 * newline-delimited JSON-RPC 2.0 — initialize, tools/list, tools/call, ping.
 *
 * The claim outcome is encoded in the task id so the stub stays stateless: a task
 * id containing "taken" is already someone else's; anything else is free.
 *
 * The response shape ({ id, entry, claim?, assignee? }) is maintained by hand
 * against the real contextnest-community `context_task_log` contract — there is no
 * schema validating it here, so a wire-contract change must be mirrored above.
 */
import { createInterface } from "node:readline";

/** The actor the server attributes the entry to (it comes from the API key). */
const ACTOR = "you@example.com";
/** Who already holds a "taken" task. */
const OTHER = "lead@example.com";

const TOOLS = [
  {
    name: "context_task_log",
    description: "Log an interaction on a task (stub).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        note: { type: "string" },
        status: { type: "string" },
        claim: { type: "boolean" },
        client: { type: "object" },
      },
      required: ["id", "note"],
    },
  },
];

function taskLog(args = {}) {
  const { id, note, status, claim, client } = args;
  const entry = {
    actor: ACTOR,
    note,
    ...(status ? { status } : {}),
    ...(client?.agent ? { client: { agent: client.agent } } : {}),
  };
  const taken = String(id).includes("taken");
  const claimFields = claim
    ? taken
      ? { claim: "assigned_to_other", assignee: OTHER }
      : { claim: "assigned", assignee: ACTOR }
    : {};
  return {
    content: [{ type: "text", text: `Logged an entry on ${id}.` }],
    structuredContent: { id, entry, ...claimFields },
  };
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin })
  .on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (method === undefined) return; // a response to us — ignore
    switch (method) {
      case "initialize":
        return reply(id, {
          // Echo the client's protocol version so the handshake always matches.
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "task-nest-stub", version: "0.0.0" },
        });
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS });
      case "tools/call":
        if (params?.name !== "context_task_log") return fail(id, -32602, `Unknown tool: ${params?.name}`);
        return reply(id, taskLog(params?.arguments));
      default:
        // Notifications (no id) get no reply; unknown requests get method-not-found.
        if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
    }
  })
  .on("close", () => process.exit(0));
