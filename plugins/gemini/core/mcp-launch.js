/**
 * Context Nest plugin — the MCP server the plugin's `.mcp.json` starts.
 *
 * Claude Code can't switch a plugin's MCP server on or off from a setting, and
 * one entry can't switch between stdio and HTTP. So the plugin declares this
 * one stdio command and the `connection` setting picks what it runs:
 *
 *   cli            an MCP server with nothing in it (hooks and agents use ctx)
 *   mcp-local      contextnest-mcp-server on the pinned vault (else the usual resolution)
 *   mcp-community  `ctx --vault <vault or promptowl> mcp`: a hosted nest, signed in with `ctx login`
 *
 * `cli` answers instead of exiting so the server doesn't show as failed in /mcp.
 *
 * SINGLE SOURCE OF TRUTH: lives at plugins/shared/core/; vendored by
 * scripts/sync-plugins.mjs. Edit it here, then run `pnpm plugins:sync`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BUNDLED_CLI, CLI_PACKAGE, getConfig, isMain, winQuote } from "./lib.js";

export const SERVER_PACKAGE = "@promptowl/contextnest-mcp-server";

/** The MCP server Claude Code installs with the plugin (its package.json pins it). */
export const BUNDLED_SERVER = fileURLToPath(
  new URL(`../node_modules/${SERVER_PACKAGE}/dist/index.js`, import.meta.url),
);

/**
 * The command for the configured connection, or null for `cli`. The plugin's
 * pinned copy first, else npx, like bin/ctx.
 *
 * @param {ReturnType<typeof getConfig>} config
 * @returns {{ command: string, args: string[] } | null}
 */
export function run(config, { exists = existsSync, bundledServer = BUNDLED_SERVER, bundledCli = BUNDLED_CLI } = {}) {
  if (config.connection === "mcp-local") {
    const vault = config.vault ? [config.vault] : [];
    return exists(bundledServer)
      ? { command: process.execPath, args: [bundledServer, ...vault] }
      : { command: "npx", args: ["-y", SERVER_PACKAGE, ...vault] };
  }
  if (config.connection === "mcp-community") {
    const args = ["--vault", config.vault || "promptowl", "mcp"];
    return exists(bundledCli)
      ? { command: process.execPath, args: [bundledCli, ...args] }
      : { command: "npx", args: ["-y", CLI_PACKAGE, ...args] };
  }
  return null;
}

/** Empty results for the list calls a client may make even without the capability. */
const EMPTY_LISTS = {
  "tools/list": { tools: [] },
  "prompts/list": { prompts: [] },
  "resources/list": { resources: [] },
  "resources/templates/list": { resourceTemplates: [] },
};

/**
 * The `cli` connection's reply to one JSON-RPC line: an MCP server that
 * offers nothing. Null for notifications and unparseable input.
 */
export function idleReply(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") {
    return reply({
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: {},
      serverInfo: { name: "contextnest", version: "0.0.0-cli" },
      instructions: "Context Nest runs through the ctx CLI here (plugin setting connection: cli); this server has no tools.",
    });
  }
  if (msg.method === "ping") return reply({});
  if (EMPTY_LISTS[msg.method]) return reply(EMPTY_LISTS[msg.method]);
  return {
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: "Context Nest MCP is off (plugin setting connection: cli)." },
  };
}

if (isMain(import.meta.url)) {
  const target = run(getConfig(process.env));
  if (!target) {
    createInterface({ input: process.stdin }).on("line", (line) => {
      const reply = idleReply(line);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  } else {
    // npm installs npx as a .cmd shim on Windows, which Node only runs through a shell (see lib.js makeExec).
    const shell = process.platform === "win32" && target.command === "npx";
    const child = spawn(shell ? winQuote(target.command) : target.command, shell ? target.args.map(winQuote) : target.args, {
      stdio: "inherit",
      shell,
    });
    child.on("error", (err) => {
      process.stderr.write(`contextnest: could not start ${target.command}: ${err.message}\n`);
      process.exit(1);
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  }
}
