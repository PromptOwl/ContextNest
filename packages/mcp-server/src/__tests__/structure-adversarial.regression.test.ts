/**
 * [regression] The QA rounds' adversarial probes that need the built MCP
 * server: attacks on the hand-written and deprecated tools, whose handlers live
 * only in src/index.ts. Engine-level probes are in the engine's
 * structure-adversarial.test.ts. Run with `pnpm test:regression`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NestStorage, setStructure } from "@promptowl/contextnest-engine";

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../../fixtures/minimal-vault", import.meta.url));

async function connect(vaultPath: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  delete env.CTX_NEST_HOME;
  env.CONTEXTNEST_VAULT_PATH = vaultPath;
  const client = new Client({ name: "structure-adversarial", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env }));
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
  return { text: (res.content ?? []).map((c) => c.text ?? "").join(""), isError: res.isError === true };
}

describe("[regression] MCP server — structure adversarial probes", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), "ctx-mcp-adversarial-"));
    await cp(FIXTURES, vault, { recursive: true });
    await setStructure(new NestStorage(vault), {
      structure: { enforce: true, closed: true },
      folders: { notes: { types: ["document"], template: "n" } },
      templates: { n: { body: "## Summary\n", required_sections: ["Summary"] } },
    });
    client = await connect(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("r5 calls1 / r6 calls-a: the deprecated publish_document and update_document never touch a reserved path", async () => {
    const raw = "---\ntitle: Evil\ntype: document\nstatus: draft\n---\nold\n";
    const planted = ["packs/evil", "_suggestions/x", "nodes/.versions/x"];
    for (const id of planted) {
      await mkdir(dirname(join(vault, `${id}.md`)), { recursive: true });
      await writeFile(join(vault, `${id}.md`), raw, "utf-8");
    }
    for (const path of ["packs/evil", "PACKS/evil", ".Context./evil", ".context::$INDEX_ALLOCATION/evil", "_\u017Fuggestions/evil"]) {
      const { text, isError } = await callText(client, "publish_document", { path });
      expect(isError, path).toBe(true);
      expect(text, path).toMatch(/reserved path/);
    }
    for (const path of ["_suggestions/x", "Packs/x", "nodes/.versions/x", "nodes/_Suggestions./x"]) {
      const { text, isError } = await callText(client, "update_document", { path, body: "SHOULD-NOT-LAND" });
      expect(isError, path).toBe(true);
      expect(text, path).toMatch(/reserved path/);
    }
    for (const id of planted) expect(await readFile(join(vault, `${id}.md`), "utf-8"), id).toBe(raw);
  });

  // r8 rx / calls-r8 (fixed in round 25): list_documents trimmed
  // its path with `/\/+$/` before normalizeDocumentId refuses the length, and
  // that regex retries from every slash of a run that does not end the string:
  // quadratic, synchronous, on the server's only thread (40k slashes ≈ 1.3 s,
  // 100k ≈ 8 s here). A backtracking regex has nothing to count from outside
  // the server, so the bound is on time — generous: linear handling of the
  // request takes milliseconds. Repro: list_documents { path: "nodes/a" +
  // "/".repeat(120_000) + "x" }.
  it("r8 rx: a list_documents path of 120k slashes is refused for its length without a quadratic trim", async () => {
    const started = performance.now();
    const { text, isError } = await callText(client, "list_documents", { path: `nodes/a${"/".repeat(120_000)}x` });
    const elapsed = performance.now() - started;
    expect(isError).toBe(true);
    expect(text).toMatch(/longer than 4096 characters/);
    expect(elapsed).toBeLessThan(2_000);
  });
});
