/**
 * The plugin's MCP entry (.mcp.json → core/mcp-launch.js): the `connection`
 * setting picks what it runs, and `cli` answers as an empty MCP server.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { run, idleReply, BUNDLED_SERVER, SERVER_PACKAGE } from "../shared/core/mcp-launch.js";
import { BUNDLED_CLI, CLI_PACKAGE, getConfig } from "../shared/core/lib.js";

const LAUNCHER = fileURLToPath(new URL("../shared/core/mcp-launch.js", import.meta.url));
const empty = () => mkdtempSync(join(tmpdir(), "cn-mcp-launch-"));
const config = (env: Record<string, string>) => {
  const dir = empty();
  return getConfig(env, { cwd: dir, homedir: dir });
};

describe("connection setting", () => {
  it("defaults to cli and skips values it doesn't know", () => {
    expect(config({}).connection).toBe("cli");
    expect(config({ CLAUDE_PLUGIN_OPTION_CONNECTION: "MCP-Local " }).connection).toBe("mcp-local");
    expect(config({ CLAUDE_PLUGIN_OPTION_CONNECTION: "banana", CONTEXTNEST_CONNECTION: "mcp-community" }).connection).toBe(
      "mcp-community",
    );
  });
});

describe("run() picks the command", () => {
  const has = () => true;
  const none = () => false;

  it("cli starts nothing", () => {
    expect(run(config({}), { exists: has })).toBeNull();
  });

  it("mcp-local runs the pinned server on the pinned vault, else npx", () => {
    const cfg = config({ CLAUDE_PLUGIN_OPTION_CONNECTION: "mcp-local", CLAUDE_PLUGIN_OPTION_VAULT: "work" });
    expect(run(cfg, { exists: has })).toEqual({ command: process.execPath, args: [BUNDLED_SERVER, "work"] });
    expect(run(cfg, { exists: none })).toEqual({ command: "npx", args: ["-y", SERVER_PACKAGE, "work"] });
    // No pinned vault: no argument, so the server's own resolution (local walk-up, registry default) applies.
    expect(run(config({ CLAUDE_PLUGIN_OPTION_CONNECTION: "mcp-local" }), { exists: has })!.args).toEqual([BUNDLED_SERVER]);
  });

  it("mcp-community serves the pinned hosted nest through ctx mcp, promptowl by default", () => {
    const cfg = config({ CLAUDE_PLUGIN_OPTION_CONNECTION: "mcp-community", CLAUDE_PLUGIN_OPTION_VAULT: "promptowl/acme" });
    expect(run(cfg, { exists: has })).toEqual({
      command: process.execPath,
      args: [BUNDLED_CLI, "--vault", "promptowl/acme", "mcp"],
    });
    expect(run(config({ CLAUDE_PLUGIN_OPTION_CONNECTION: "mcp-community" }), { exists: none })).toEqual({
      command: "npx",
      args: ["-y", CLI_PACKAGE, "--vault", "promptowl", "mcp"],
    });
  });
});

describe("cli mode is an empty MCP server", () => {
  it("answers initialize, ping and the list calls; ignores notifications and junk", () => {
    expect(idleReply(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })))
      .toMatchObject({ id: 1, result: { protocolVersion: "2025-11-25", capabilities: {} } });
    expect(idleReply(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }))).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(idleReply(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }))!.result).toEqual({ tools: [] });
    expect(idleReply(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call" }))!.error.code).toBe(-32601);
    expect(idleReply(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(idleReply("not json")).toBeNull();
  });

  it("speaks over stdio when launched", async () => {
    const dir = empty();
    const child = spawn(process.execPath, [LAUNCHER], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_OPTION_CONNECTION: "cli" },
    });
    const lines: string[] = [];
    const twoReplies = new Promise<void>((resolve) => {
      child.stdout.setEncoding("utf-8").on("data", (d: string) => {
        lines.push(...d.split("\n").filter(Boolean));
        if (lines.length >= 2) resolve();
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await twoReplies;
    child.kill();
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
  });
});

describe(".mcp.json", () => {
  it("starts the launcher with the connection and vault settings", () => {
    const mcp = JSON.parse(readFileSync(new URL("../claude-code/.mcp.json", import.meta.url), "utf-8"));
    const entry = mcp.mcpServers.contextnest;
    expect(entry.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/core/mcp-launch.js"]);
    expect(entry.env.CLAUDE_PLUGIN_OPTION_CONNECTION).toBe("${user_config.connection}");
    expect(entry.env.CLAUDE_PLUGIN_OPTION_VAULT).toBe("${user_config.vault}");
    const manifest = JSON.parse(readFileSync(new URL("../claude-code/.claude-plugin/plugin.json", import.meta.url), "utf-8"));
    expect(manifest.userConfig.connection.options).toEqual(["cli", "mcp-local", "mcp-community"]);
  });
});
