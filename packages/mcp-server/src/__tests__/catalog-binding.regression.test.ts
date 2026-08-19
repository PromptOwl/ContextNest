/**
 * [regression] Contract suite — MCP server bound to the canonical operation
 * catalog (API Convergence Phase 2).
 *
 * Written test-first for docs/plans/remote-nests-mcp-integration.md §2/§4.2;
 * the implementation (server generated from `@promptowl/contextnest-engine/api`
 * instead of hand-written inline schemas) landed on this same branch, and this
 * suite is now the normative contract guarding it against regressions.
 *
 * Contract under test:
 *  1. Every `core` catalog operation is exposed as an MCP tool under its
 *     canonical `context_*` name, with the catalog's description and an input
 *     schema generated from the catalog (no inline schema drift).
 *  2. Every catalog alias (the legacy OSS tool names: read_document, resolve,
 *     …) is still exposed as a deprecated tool for the migration window, and
 *     answers identically to its canonical twin.
 *  3. Legacy tools with no canonical equivalent yet (document_format,
 *     read_index, read_pack, list_checkpoints, drift suite) remain available.
 *  4. Success payloads parse under the catalog's OUTPUT Zod schemas — the
 *     wire shape is the catalog shape.
 *  5. Errors are structured: an isError result whose text is JSON carrying a
 *     `code` from the catalog's ERROR_CODES (this is what lets the remote CLI
 *     backend map failures back to typed engine errors).
 *
 * Like mcp-server.regression.test.ts, this spawns the *built* server
 * (dist/index.js) and drives it through a real MCP SDK client over stdio.
 * Run with `pnpm test:regression`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  listOperations,
  getOperation,
  inputJsonSchema,
  ERROR_CODES,
} from "@promptowl/contextnest-engine/api";

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../../fixtures/minimal-vault", import.meta.url));

/** Legacy tools that have no canonical `context_*` equivalent yet. They must
 *  survive the Phase 2 migration untouched (they migrate in later phases). */
const LEGACY_ONLY_TOOLS = [
  "document_format",
  "read_index",
  "read_pack",
  "list_checkpoints",
  "stage_drift_suggestion",
  "list_suggestions",
  "approve_suggestion",
  "reject_suggestion",
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function freshVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ctx-catalog-regression-"));
  await cp(FIXTURES, dir, { recursive: true });
  return dir;
}

async function connect(vaultPath: string): Promise<Client> {
  const env: Record<string, string> = { CONTEXTNEST_VAULT_PATH: vaultPath };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
  });
  const client = new Client({ name: "catalog-regression-test", version: "1.0.0" });
  await client.connect(transport);
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

async function callJson<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { text, isError } = await callText(client, name, args);
  expect(isError, `${name} unexpectedly errored: ${text}`).toBe(false);
  return JSON.parse(text) as T;
}

/** Call a tool expected to fail; return the parsed structured-error payload. */
async function callError(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string }> {
  const { text, isError } = await callText(client, name, args);
  expect(isError, `${name} was expected to error but succeeded: ${text}`).toBe(true);
  const parsed = JSON.parse(text) as { code: string; message: string };
  expect(typeof parsed.code).toBe("string");
  expect(typeof parsed.message).toBe("string");
  return parsed;
}

const CORE_OPS = listOperations("core");

/**
 * Normalize a query-shaped payload for identity comparison: graph traversal
 * does not guarantee document ORDER between calls, so sort by id. The
 * contract under test is "same documents, same shapes, same metadata" — not
 * a stable iteration order.
 */
function sortedQueryResult<T extends { documents?: any[]; source_nodes?: any[] }>(payload: T): T {
  const byId = (a: any, b: any) => String(a.id).localeCompare(String(b.id));
  return {
    ...payload,
    ...(payload.documents ? { documents: [...payload.documents].sort(byId) } : {}),
    ...(payload.source_nodes ? { source_nodes: [...payload.source_nodes].sort(byId) } : {}),
  };
}

// ─── Tool surface ───────────────────────────────────────────────────────────

describe("[regression] catalog binding — tool surface", () => {
  let vault: string;
  let client: Client;
  let toolsByName: Map<string, { name: string; description?: string; inputSchema: any }>;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
    const { tools } = await client.listTools();
    toolsByName = new Map(tools.map((t) => [t.name, t as any]));
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("exposes every core catalog operation under its canonical context_* name", () => {
    for (const op of CORE_OPS) {
      expect(toolsByName.has(op.name), `missing canonical tool ${op.name}`).toBe(true);
    }
  });

  it("canonical tools carry the catalog description verbatim", () => {
    for (const op of CORE_OPS) {
      const tool = toolsByName.get(op.name);
      expect(tool, `missing canonical tool ${op.name}`).toBeTruthy();
      expect(tool!.description, `description drift on ${op.name}`).toBe(op.description);
    }
  });

  it("canonical tools' input schemas come from the catalog (no inline drift)", () => {
    for (const op of CORE_OPS) {
      const tool = toolsByName.get(op.name);
      expect(tool, `missing canonical tool ${op.name}`).toBeTruthy();
      const expected = inputJsonSchema(op) as { properties?: Record<string, unknown> };
      const actualProps = Object.keys(tool!.inputSchema?.properties ?? {}).sort();
      const expectedProps = Object.keys(expected.properties ?? {}).sort();
      expect(actualProps, `input property drift on ${op.name}`).toEqual(expectedProps);
    }
  });

  it("exposes every catalog alias as a deprecated legacy tool", () => {
    for (const op of CORE_OPS) {
      for (const alias of op.aliases ?? []) {
        const tool = toolsByName.get(alias);
        expect(tool, `missing legacy alias tool ${alias} (for ${op.name})`).toBeTruthy();
        // The migration-window contract: alias descriptions steer agents to
        // the canonical name.
        expect(tool!.description ?? "", `alias ${alias} not marked deprecated`).toMatch(
          /deprecated/i,
        );
        expect(tool!.description ?? "", `alias ${alias} does not name its successor`).toContain(
          op.name,
        );
      }
    }
  });

  it("keeps the legacy-only tools (no canonical equivalent yet) available", () => {
    for (const name of LEGACY_ONLY_TOOLS) {
      expect(toolsByName.has(name), `legacy-only tool ${name} disappeared`).toBe(true);
    }
  });

  it("getOperation resolves each exposed alias back to its canonical op", () => {
    // Guards the alias table itself: every alias the server exposes must be
    // resolvable by the same lookup the remote CLI backend will use.
    for (const op of CORE_OPS) {
      for (const alias of op.aliases ?? []) {
        expect(getOperation(alias)?.name).toBe(op.name);
      }
    }
  });
});

// ─── Read surface round-trips ───────────────────────────────────────────────

describe("[regression] catalog binding — read operations return catalog shapes", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
    // Warm the vault index: the first query against a fixture without
    // context.yaml triggers auto-indexing, and a query racing that warmup can
    // see different traversal results than the next one.
    await callJson(client, "context_query", { query: "#engineering" });
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  /** Assert a payload parses under the op's catalog OUTPUT schema. */
  function expectOutputShape(opName: string, payload: unknown): void {
    const op = getOperation(opName)!;
    const parsed = op.output.safeParse(payload);
    expect(
      parsed.success,
      `${opName} payload does not match catalog output schema: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`,
    ).toBe(true);
  }

  it("context_get returns a full document by id", async () => {
    const json = await callJson(client, "context_get", { id: "nodes/api-design" });
    expectOutputShape("context_get", json);
    expect(json.id).toBe("nodes/api-design");
    expect(json.frontmatter.title).toBe("API Design Guidelines");
    expect(json.body).toContain("API Design Guidelines");
  });

  it("legacy alias read_document answers identically to context_get", async () => {
    const canonical = await callJson(client, "context_get", { id: "nodes/api-design" });
    const legacy = await callJson(client, "read_document", { id: "nodes/api-design" });
    expect(legacy).toEqual(canonical);
  });

  it("context_query runs a selector with traversal metadata", async () => {
    const json = await callJson(client, "context_query", { query: "#engineering" });
    expectOutputShape("context_query", json);
    expect(json.documents.length).toBeGreaterThan(0);
  });

  it("legacy alias resolve answers identically to context_query", async () => {
    const canonical = await callJson(client, "context_query", { query: "#engineering" });
    const legacy = await callJson(client, "resolve", { query: "#engineering" });
    expect(sortedQueryResult(legacy)).toEqual(sortedQueryResult(canonical));
  });

  it("context_search returns scored summaries", async () => {
    const json = await callJson(client, "context_search", { query: "API" });
    expectOutputShape("context_search", json);
    expect(json.results.length).toBeGreaterThan(0);
  });

  it("context_list filters by type", async () => {
    const json = await callJson(client, "context_list", { type: "document" });
    expectOutputShape("context_list", json);
    expect(json.documents.length).toBeGreaterThan(0);
    for (const doc of json.documents) expect(doc.type).toBe("document");
  });

  it("context_resolve returns full documents within a token budget", async () => {
    const json = await callJson(client, "context_resolve", {
      selector: "#engineering",
      max_tokens: 4000,
    });
    expectOutputShape("context_resolve", json);
    expect(json.documents.length).toBeGreaterThan(0);
  });

  it("context_init returns the vault CONTEXT.md", async () => {
    const json = await callJson(client, "context_init");
    expectOutputShape("context_init", json);
    expect(json.context_md).toBeTruthy();
    // context_overview is gone; its counts live here now.
    expect(json.total).toBeGreaterThan(0);
  });

  it("context_packs lists the fixture pack", async () => {
    const json = await callJson(client, "context_packs");
    expectOutputShape("context_packs", json);
    expect(json.packs.length).toBeGreaterThan(0);
  });

  it("context_verify reports a valid vault", async () => {
    const json = await callJson(client, "context_verify");
    expectOutputShape("context_verify", json);
    expect(json.valid).toBe(true);
  });
});

// ─── Write surface round-trips ──────────────────────────────────────────────

describe("[regression] catalog binding — write lifecycle via canonical ops", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("create → update → publish → versions → reconstruct → delete round-trips", async () => {
    const created = await callJson(client, "context_create", {
      title: "Catalog Binding Note",
      content: "First body.",
      tags: ["#tdd"],
    });
    expect(getOperation("context_create")!.output.safeParse(created).success).toBe(true);
    const id = created.id as string;

    const updated = await callJson(client, "context_update", {
      id,
      content: "Second body.",
    });
    expect(updated.id).toBe(id);

    const published = await callJson(client, "context_publish", { id });
    expect(getOperation("context_publish")!.output.safeParse(published).success).toBe(true);
    expect(published.version).toBeGreaterThanOrEqual(1);

    const versions = await callJson(client, "context_versions", { id });
    expect(getOperation("context_versions")!.output.safeParse(versions).success).toBe(true);
    expect(versions.versions.length).toBeGreaterThanOrEqual(1);

    const firstVersion = versions.versions[0].version as number;
    const reconstructed = await callJson(client, "context_reconstruct", {
      id,
      version: firstVersion,
    });
    expect(getOperation("context_reconstruct")!.output.safeParse(reconstructed).success).toBe(true);

    const deleted = await callJson(client, "context_delete", { id });
    expect(deleted).toMatchObject({ id, deleted: true });
  });

  it("context_import bulk-creates documents and reports per-doc failures", async () => {
    const json = await callJson(client, "context_import", {
      documents: [
        { title: "Import A", content: "a", tags: ["#import"] },
        { title: "Import B", content: "b", tags: ["#import"] },
      ],
    });
    expect(getOperation("context_import")!.output.safeParse(json).success).toBe(true);
    expect(json.published.length).toBe(2);
    expect(json.failed.length).toBe(0);
  });
});

// ─── Alias adapter edge cases ───────────────────────────────────────────────

describe("[regression] catalog binding — alias adapter edge cases", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
    // Warm the auto-generated index before any query-identity comparison.
    await callJson(client, "context_query", { query: "#engineering" });
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("read_document still accepts a plain path in its legacy uri param", async () => {
    const legacy = await callJson(client, "read_document", { uri: "nodes/api-design" });
    const canonical = await callJson(client, "context_get", { id: "nodes/api-design" });
    expect(legacy).toEqual(canonical);
  });

  it("read_document accepts a real contextnest:// uri", async () => {
    const byUri = await callJson(client, "read_document", {
      uri: "contextnest://nodes/api-design",
    });
    expect(byUri.id).toBe("nodes/api-design");
  });

  it("context_get resolves by uri and by title too", async () => {
    const byUri = await callJson(client, "context_get", {
      uri: "contextnest://nodes/api-design",
    });
    expect(byUri.id).toBe("nodes/api-design");
    const byTitle = await callJson(client, "context_get", { title: "API Design Guidelines" });
    expect(byTitle.id).toBe("nodes/api-design");
  });

  it("context_get include_raw returns the exact on-disk bytes", async () => {
    const got = await callJson(client, "context_get", {
      id: "nodes/api-design",
      include_raw: true,
    });
    const { readFile } = await import("node:fs/promises");
    const onDisk = await readFile(join(vault, "nodes", "api-design.md"), "utf-8");
    expect(got.raw).toBe(onDisk);
  });

  it("resolve accepts the legacy selector param and answers like canonical query", async () => {
    const legacy = await callJson(client, "resolve", { selector: "#engineering" });
    const canonical = await callJson(client, "context_query", { query: "#engineering" });
    expect(sortedQueryResult(legacy)).toEqual(sortedQueryResult(canonical));
  });

  it("resolve with neither query nor selector returns a structured VALIDATION_FAILED", async () => {
    const err = await callError(client, "resolve", {});
    expect(err.code).toBe("VALIDATION_FAILED");
  });
});

// ─── Structured errors ──────────────────────────────────────────────────────

describe("[regression] catalog binding — structured error contract", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("context_get on a missing document yields code DOCUMENT_NOT_FOUND", async () => {
    const err = await callError(client, "context_get", { id: "nodes/no-such-doc" });
    expect(err.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("context_query with an invalid selector yields a catalog error code", async () => {
    const err = await callError(client, "context_query", { query: "+++" });
    expect(ERROR_CODES).toContain(err.code);
  });

  it("legacy alias errors carry the same structured payload as canonical ones", async () => {
    const canonical = await callError(client, "context_get", { id: "nodes/no-such-doc" });
    const legacy = await callError(client, "read_document", { id: "nodes/no-such-doc" });
    expect(legacy.code).toBe(canonical.code);
  });

  it("context_delete on a missing document yields DOCUMENT_NOT_FOUND", async () => {
    const err = await callError(client, "context_delete", { id: "nodes/no-such-doc" });
    expect(err.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("context_create with an un-sluggable title yields a structured VALIDATION_FAILED", async () => {
    // "!!!" passes the schema (string, 1–200 chars) but has no slug-able
    // characters, so the ENGINE rejects it — this pins the structured error
    // contract for semantically-invalid input. (Schema-invalid input, e.g. a
    // malformed tag, is rejected earlier by MCP protocol-level validation,
    // which is standard SDK behavior and not part of this contract.)
    const err = await callError(client, "context_create", {
      title: "!!!",
      content: "b",
    });
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toMatch(/slug/i);
  });

  it("content edits on a rejected doc yield REJECTED_DOCUMENT across surfaces", async () => {
    // Create canonically, retire via the legacy status-transition surface
    // (the catalog has no status op yet), then hit both read and update.
    await callJson(client, "context_create", {
      id: "nodes/retired-probe",
      title: "Retired Probe",
      content: "b",
    });
    await callJson(client, "update_document", { path: "nodes/retired-probe", status: "rejected" });

    const updateErr = await callError(client, "context_update", {
      id: "nodes/retired-probe",
      content: "sneaky",
    });
    expect(updateErr.code).toBe("REJECTED_DOCUMENT");

    const getErr = await callError(client, "context_get", { id: "nodes/retired-probe" });
    expect(getErr.code).toBe("REJECTED_DOCUMENT");
  });
});
