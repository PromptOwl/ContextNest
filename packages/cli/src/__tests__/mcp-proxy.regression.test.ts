/**
 * `ctx mcp` serves a hosted nest over stdio, end to end: the compiled CLI
 * (dist/index.js) against the real loopback Community-style server in
 * helpers/nest-server.ts, signed in with `ctx login --key-stdin`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listOperations, MCP_SERVER_INSTRUCTIONS } from "@promptowl/contextnest-engine/api";
import { startNestServer, type NestServer } from "./helpers/nest-server.js";

const distPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const KEY = "cnst_test_key_0001";

describe("ctx mcp (regression)", () => {
  let home: string;
  let server: NestServer;
  let env: Record<string, string>;
  let client: Client;

  const ctx = (args: string[], input = "", extra: Record<string, string> = {}): Promise<{ status: number; stderr: string }> =>
    new Promise((resolve) => {
      const opts = { cwd: home, env: { ...env, ...extra }, encoding: "utf-8" as const, timeout: 30_000 };
      const child = execFile("node", [distPath, ...args], opts, (err, _out, stderr) =>
        resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
      );
      child.stdin?.end(input);
    });

  beforeAll(async () => {
    server = await startNestServer({ nests: [{ id: "n-alpha-0001", name: "Alpha" }], validKeys: [KEY] });
    home = mkdtempSync(join(tmpdir(), "cn-mcp-proxy-"));
    env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CI: "",
      CONTEXTNEST_NO_BROWSER: "1",
      CONTEXTNEST_CONFIG_DIR: join(home, ".contextnest"),
      CONTEXTNEST_CREDENTIALS_BACKEND: "file",
      CONTEXTNEST_CREDENTIALS_KEY: "test-passphrase",
      CONTEXTNEST_VAULT: "",
      CONTEXTNEST_VAULT_PATH: "",
    });
    expect((await ctx(["login", server.url, "--key-stdin", "--as", "po"], KEY)).status).toBe(0);
    client = new Client({ name: "mcp-proxy-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [distPath, "--vault", "po/alpha", "mcp"], env, cwd: home }),
    );
  });

  afterAll(async () => {
    await client?.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("offers the core catalog, the shared prompts and the instructions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(listOperations("core").map((o) => o.name).sort());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["capture", "recall"]);
    expect(client.getInstructions()).toBe(MCP_SERVER_INSTRUCTIONS);
  });

  it("runs a tool on the named nest", async () => {
    const res = (await client.callTool({ name: "context_list", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0].text).documents[0].id).toBe("nodes/in-n-alpha-0001");
  });

  it("returns a remote failure as the structured error", async () => {
    // The test server has no context_get: the refusal must come back as { code, message }, not crash the proxy.
    const res = (await client.callTool({ name: "context_get", arguments: { id: "nodes/x" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ code: expect.any(String), message: expect.any(String) });
  });

  it("refuses a local vault", async () => {
    // The login made `po` the default, so point resolution at a local vault instead.
    const local = fileURLToPath(new URL("../../../../fixtures/minimal-vault", import.meta.url));
    const res = await ctx(["mcp"], "", { CONTEXTNEST_VAULT_PATH: local });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("For a local vault run contextnest-mcp-server");
  });
});
