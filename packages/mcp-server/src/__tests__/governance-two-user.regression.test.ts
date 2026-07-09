/**
 * [regression] Two-user story through the REAL built MCP server.
 *
 * The proprietary governance module is injected via
 * CONTEXTNEST_GOVERNANCE_MODULE, and each user connects with their own
 * identity via CONTEXTNEST_ACTOR (the per-deployment identity channel for
 * MCP). Emma (editor@acme.com) mutates the vault through MCP tools; Victor
 * (viewer@acme.com) can read/search but every mutation tool returns a tool
 * error; the stranger cannot read at all.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, cp, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../../fixtures/minimal-vault", import.meta.url));

const EMMA = "editor@acme.com";
const VICTOR = "viewer@acme.com";
const STRANGER = "stranger@evil.com";

const ACME_GOVERNANCE_MODULE = `
const READERS = ["${EMMA}", "${VICTOR}"];
const EDITORS = ["${EMMA}"];
export default function createGovernance() {
  return {
    hooks: {
      isCzar: (actor) => EDITORS.includes(actor),
      canIngest: (actor) => READERS.includes(actor),
      isDocOwner: (actor) => EDITORS.includes(actor),
      canRead: (actor) => READERS.includes(actor),
      canCommit: (actor) => EDITORS.includes(actor),
    },
  };
}
`;

let vault: string;
let modulePath: string;
const clients: Client[] = [];

async function connectAs(actor: string): Promise<Client> {
  const env: Record<string, string> = {
    CONTEXTNEST_VAULT_PATH: vault,
    CONTEXTNEST_GOVERNANCE_MODULE: modulePath,
    CONTEXTNEST_ACTOR: actor,
  };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !(k in env)) env[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
  });
  const client = new Client({ name: `regression-${actor}`, version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

interface ToolText {
  text: string;
  isError: boolean;
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolText> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = (res.content ?? []).map((c) => c.text ?? "").join("");
  return { text, isError: res.isError === true };
}

beforeAll(async () => {
  vault = await mkdtemp(join(tmpdir(), "ctx-mcp-two-user-"));
  await cp(FIXTURES, vault, { recursive: true });
  const modDir = await mkdtemp(join(tmpdir(), "ctx-mcp-two-user-gov-"));
  modulePath = join(modDir, "acme-governance.mjs");
  await writeFile(modulePath, ACME_GOVERNANCE_MODULE, "utf-8");
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await rm(vault, { recursive: true, force: true });
  await rm(dirname(modulePath), { recursive: true, force: true });
});

describe("[regression] two users, one governed vault (MCP e2e)", () => {
  it("Emma creates and publishes a doc through MCP tools", async () => {
    const emma = await connectAs(EMMA);

    const created = await callText(emma, "create_document", {
      id: "nodes/team-guide",
      title: "Team Guide",
      body: "How Acme works.",
      tags: ["onboarding"],
    });
    expect(created.isError).toBe(false);

    const published = await callText(emma, "publish_document", {
      id: "nodes/team-guide",
    });
    expect(published.isError).toBe(false);
  });

  it("Victor can read and search the published doc", async () => {
    const victor = await connectAs(VICTOR);

    const read = await callText(victor, "read_document", { id: "nodes/team-guide" });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("Team Guide");

    const search = await callText(victor, "search", { query: "Team Guide" });
    expect(search.isError).toBe(false);
  });

  it("Victor's mutation tools all return tool errors (server stays alive)", async () => {
    const victor = await connectAs(VICTOR);

    const update = await callText(victor, "update_document", {
      id: "nodes/team-guide",
      body: "Vandalized by Victor",
    });
    expect(update.isError).toBe(true);

    const publish = await callText(victor, "publish_document", { id: "nodes/team-guide" });
    expect(publish.isError).toBe(true);

    const del = await callText(victor, "delete_document", { id: "nodes/team-guide" });
    expect(del.isError).toBe(true);

    // Server is still responsive after the denied calls, and content is intact.
    const read = await callText(victor, "read_document", { id: "nodes/team-guide" });
    expect(read.isError).toBe(false);
    expect(read.text).not.toContain("Vandalized");
    const onDisk = await readFile(join(vault, "nodes/team-guide.md"), "utf-8");
    expect(onDisk).not.toContain("Vandalized");
  });

  it("the stranger cannot read the doc at all", async () => {
    const stranger = await connectAs(STRANGER);
    const read = await callText(stranger, "read_document", { id: "nodes/team-guide" });
    expect(read.isError).toBe(true);
  });

  it("Emma can still update after Victor's denied attempts (attribution intact)", async () => {
    const emma = await connectAs(EMMA);
    const update = await callText(emma, "update_document", {
      id: "nodes/team-guide",
      body: "How Acme works. v2",
    });
    expect(update.isError).toBe(false);
    const read = await callText(emma, "read_document", { id: "nodes/team-guide" });
    expect(read.text).toContain("v2");
  });
});
