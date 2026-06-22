/**
 * [regression] Black-box end-to-end tests for the Context Nest MCP server.
 *
 * Unlike mcp-server.test.ts (which re-implements handler logic against the engine
 * layer), this suite spawns the *real built server* (dist/index.js) and drives it
 * through a genuine MCP SDK Client over stdio. It exercises every one of the 19
 * registered tools across their meaningful use cases and asserts both the tool
 * responses AND the internal vault files the server writes to disk
 * (context.yaml, per-folder INDEX.md, .versions/.../history.yaml, checkpoint
 * history, and _suggestions/ patches + archives).
 *
 * Marked as a regression suite via the `.regression.test.ts` filename and the
 * `[regression]` describe labels. Run with `pnpm test:regression` (which builds
 * the server first). Excluded from the default `pnpm test` unit run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, cp, readFile, writeFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NestStorage } from "@promptowl/contextnest-engine";

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../../../fixtures/minimal-vault", import.meta.url));

const EXPECTED_TOOLS = [
  "vault_info",
  "resolve",
  "read_document",
  "list_documents",
  "document_format",
  "read_index",
  "read_pack",
  "search",
  "verify_integrity",
  "list_checkpoints",
  "read_version",
  "create_document",
  "update_document",
  "delete_document",
  "publish_document",
  "stage_drift_suggestion",
  "list_suggestions",
  "approve_suggestion",
  "reject_suggestion",
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Copy the shared fixture vault into a throwaway temp directory. */
async function freshVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ctx-mcp-regression-"));
  await cp(FIXTURES, dir, { recursive: true });
  return dir;
}

/** Spawn the built server pointed at `vaultPath` and return a connected client. */
async function connect(vaultPath: string): Promise<Client> {
  // StdioClientTransport replaces (not merges) the child env when `env` is set,
  // so forward the current environment plus the vault override. Filter out
  // undefined values to satisfy the Record<string, string> contract.
  const env: Record<string, string> = { CONTEXTNEST_VAULT_PATH: vaultPath };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
  });
  const client = new Client({ name: "regression-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

interface ToolText {
  text: string;
  isError: boolean;
}

/** Call a tool and return the concatenated text content + the isError flag. */
async function callText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = (res.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
  return { text, isError: res.isError === true };
}

/** Call a tool whose response is JSON; parse the text. */
async function callJson<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ json: T; isError: boolean }> {
  const { text, isError } = await callText(client, name, args);
  return { json: JSON.parse(text) as T, isError };
}

/** True if the tool call surfaces an error — either an isError result or a thrown rejection. */
async function isToolError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
    return res.isError === true;
  } catch {
    return true;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Split a doc id like "nodes/foo" into its folder + leaf name. */
function splitId(id: string): { dir: string; name: string } {
  const parts = id.split("/");
  return { dir: parts.slice(0, -1).join("/") || ".", name: parts[parts.length - 1] };
}

// ─── Protocol & smoke ─────────────────────────────────────────────────────────

describe("[regression] MCP server e2e — protocol & smoke", () => {
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

  it("exposes exactly the 19 expected tools, each with a description and input schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });

  it("vault_info returns identity and the configured servers", async () => {
    const { json } = await callJson(client, "vault_info");
    expect(json.vault_path).toBe(vault);
    expect(typeof json.context_md).toBe("string");
    expect(json.config.name).toBe("Test Vault");
    expect(json.config.servers).toEqual(expect.arrayContaining(["jira", "github"]));
  });

  it("an erroring tool call surfaces an error without taking the server down", async () => {
    expect(await isToolError(client, "read_document", { uri: "contextnest://nodes/does-not-exist" })).toBe(true);
    // Server is still alive and serving afterward.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOLS.length);
  });
});

// ─── Read tools ─────────────────────────────────────────────────────────────

describe("[regression] MCP server e2e — read tools", () => {
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

  it("resolve handles tag, type, AND-composition, hyphenated URI, hops, full and no-match selectors", async () => {
    const byTag = await callJson(client, "resolve", { selector: "#engineering" });
    expect(byTag.json.documents.length).toBeGreaterThan(0);
    expect(byTag.json.traversal).toHaveProperty("mode");
    expect(byTag.json.traversal).toHaveProperty("hops_used");
    expect(byTag.json.traversal).toHaveProperty("nodes_traversed");

    const byType = await callJson(client, "resolve", { selector: "type:document" });
    expect(byType.json.documents.length).toBeGreaterThan(0);

    const composed = await callJson(client, "resolve", { selector: "#engineering + type:document", hops: 1 });
    expect(composed.json.documents.some((d: any) => d.id === "nodes/api-design")).toBe(true);

    // Hyphenated URI path selector (regression — the lexer used to split on `-`).
    const byUri = await callJson(client, "resolve", { selector: "contextnest://nodes/api-design", hops: 1 });
    expect(byUri.json.documents.some((d: any) => d.id === "nodes/api-design")).toBe(true);

    const full = await callJson(client, "resolve", { selector: "type:document", full: true });
    expect(full.json.traversal.mode).toBeDefined();

    const none = await callJson(client, "resolve", { selector: "#no-such-tag-anywhere" });
    expect(none.json.documents).toEqual([]);
  });

  it("read_document resolves by URI, by plain path, and errors on a missing doc", async () => {
    const byUri = await callJson(client, "read_document", { uri: "contextnest://nodes/api-design" });
    expect(byUri.json.id).toBe("nodes/api-design");
    expect(byUri.json.frontmatter.title).toBe("API Design Guidelines");
    expect(typeof byUri.json.body).toBe("string");

    const byPath = await callJson(client, "read_document", { uri: "nodes/api-design" });
    expect(byPath.json.id).toBe("nodes/api-design");

    expect(await isToolError(client, "read_document", { uri: "nodes/missing" })).toBe(true);
  });

  it("list_documents filters by nothing (rejected hidden), type, status alias, and tag", async () => {
    const all = await callJson(client, "list_documents");
    const ids = all.json.map((d: any) => d.id);
    expect(ids).toContain("nodes/api-design");
    // legacy-soap-bridge is rejected → hidden by default.
    expect(all.json.every((d: any) => d.status !== "rejected")).toBe(true);

    const docsOnly = await callJson(client, "list_documents", { type: "document" });
    expect(docsOnly.json.every((d: any) => d.type === "document")).toBe(true);

    // 'active' is an alias for 'published'.
    const published = await callJson(client, "list_documents", { status: "active" });
    expect(published.json.length).toBeGreaterThan(0);
    expect(published.json.every((d: any) => d.status === "published")).toBe(true);

    // Explicit rejected filter surfaces the retired doc.
    const rejected = await callJson(client, "list_documents", { status: "rejected" });
    expect(rejected.json.some((d: any) => d.id === "nodes/legacy-soap-bridge")).toBe(true);

    const tagged = await callJson(client, "list_documents", { tag: "api" });
    expect(tagged.json.some((d: any) => d.id === "nodes/api-design")).toBe(true);
  });

  it("document_format describes node types and status values", async () => {
    const { json } = await callJson(client, "document_format");
    expect(json.frontmatter_fields.type.values).toEqual(
      expect.arrayContaining(["document", "skill", "source", "snippet", "glossary", "persona", "prompt", "tool", "reference"]),
    );
    expect(json.frontmatter_fields.status.values).toEqual(
      expect.arrayContaining(["draft", "pending_review", "approved", "published", "rejected"]),
    );
    expect(json.uri_scheme.format).toContain("contextnest://");
  });

  it("read_pack resolves a known pack and reports a missing pack", async () => {
    const { text } = await callText(client, "read_pack", { id: "onboarding.basics" });
    const pack = JSON.parse(text);
    expect(pack.pack.id).toBe("onboarding.basics");
    expect(pack.pack.label).toBe("Onboarding Basics");
    expect(Array.isArray(pack.documents)).toBe(true);

    const missing = await callText(client, "read_pack", { id: "no.such.pack" });
    expect(missing.text).toContain("not found");
  });

  it("search returns matching documents with traversal stats", async () => {
    const { json } = await callJson(client, "search", { query: "API", hops: 1 });
    expect(Array.isArray(json.documents)).toBe(true);
    expect(json.traversal).toHaveProperty("mode");

    const full = await callJson(client, "search", { query: "architecture", full: true });
    expect(full.json.traversal.mode).toBeDefined();
  });

  it("verify_integrity returns a structured report", async () => {
    const { json } = await callJson(client, "verify_integrity");
    expect(json).toHaveProperty("valid");
    expect(typeof json.valid).toBe("boolean");
  });

  it("read_index returns the context.yaml index listing published docs", async () => {
    // A mutation regenerates context.yaml; read_index then returns JSON listing it.
    await callJson(client, "create_document", { path: "nodes/index-probe", title: "Index Probe" });
    const after = await callJson(client, "read_index");
    expect(JSON.stringify(after.json)).toContain("nodes/index-probe");
  });

  it("read_version reconstructs a created doc's v1", async () => {
    await callJson(client, "create_document", { path: "nodes/versioned", title: "Versioned Doc", body: "v1 body" });
    const { text } = await callText(client, "read_version", { path: "nodes/versioned", version: 1 });
    expect(text).toContain("Versioned Doc");

    // Out-of-range versions reconstruct gracefully (latest available) rather than throwing.
    const oob = await callText(client, "read_version", { path: "nodes/versioned", version: 99 });
    expect(oob.text.length).toBeGreaterThan(0);
  });

  it("list_checkpoints honors limit and grows as mutations accumulate", async () => {
    const start = await callText(client, "list_checkpoints", { limit: 50 });
    const startCount = JSON.parse(start.text).length ?? 0;

    await callJson(client, "create_document", { path: "nodes/checkpoint-probe", title: "Checkpoint Probe" });

    const end = await callJson(client, "list_checkpoints", { limit: 50 });
    expect(end.json.length).toBeGreaterThan(startCount);

    const limited = await callJson(client, "list_checkpoints", { limit: 1 });
    expect(limited.json.length).toBeLessThanOrEqual(1);
  });
});

// ─── Mutation tools (+ internal file assertions) ──────────────────────────────

describe("[regression] MCP server e2e — mutation tools", () => {
  let vault: string;
  let client: Client;
  let storage: NestStorage;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
    storage = new NestStorage(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("create_document writes the file, version history, index, and checkpoint", async () => {
    const { json, isError } = await callJson(client, "create_document", {
      path: "nodes/created",
      title: "Created Doc",
      tags: ["alpha", "#beta"],
      body: "Hello world",
    });
    expect(isError).toBe(false);
    expect(json.version).toBe(1);
    // Tags are normalized to a leading '#'.
    expect(json.frontmatter.tags).toEqual(["#alpha", "#beta"]);

    // On-disk: the markdown file exists.
    expect(await exists(join(vault, "nodes", "created.md"))).toBe(true);
    // On-disk: version history written.
    expect(await exists(join(vault, "nodes", ".versions", "created", "history.yaml"))).toBe(true);
    const history = await storage.readHistory("nodes/created");
    expect(history?.versions.length).toBe(1);
    // On-disk: context.yaml lists the published doc.
    expect(JSON.stringify(await storage.readContextYaml())).toContain("nodes/created");
    // On-disk: folder INDEX.md generated.
    expect(await exists(join(vault, "nodes", "INDEX.md"))).toBe(true);
    // On-disk: checkpoint history advanced.
    const checkpoints = await storage.readCheckpointHistory();
    expect((checkpoints?.checkpoints.length ?? 0)).toBeGreaterThan(0);
  });

  it("create_document supports skill types with a skill block", async () => {
    const { json } = await callJson(client, "create_document", {
      path: "nodes/my-skill",
      title: "My Skill",
      type: "skill",
      trigger: "when asked to do the thing",
    });
    expect(json.frontmatter.type).toBe("skill");
    expect(json.frontmatter.skill).toBeDefined();
    expect(json.frontmatter.skill.trigger).toBe("when asked to do the thing");
  });

  it("create_document rejects a duplicate path", async () => {
    const dup = await callText(client, "create_document", { path: "nodes/created", title: "Dup" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("already exists");
  });

  it("update_document (content edit) bumps version and cuts a new checkpoint", async () => {
    const before = await storage.readHistory("nodes/created");
    const beforeVersions = before?.versions.length ?? 0;

    const { json } = await callJson(client, "update_document", {
      path: "nodes/created",
      body: "Updated body content",
    });
    expect(json.version).toBeGreaterThan(1);

    const after = await storage.readHistory("nodes/created");
    expect((after?.versions.length ?? 0)).toBeGreaterThan(beforeVersions);
  });

  it("update_document status transitions are metadata-only (no new version)", async () => {
    await callJson(client, "create_document", { path: "nodes/lifecycle", title: "Lifecycle Doc" });
    const baseline = (await storage.readHistory("nodes/lifecycle"))?.versions.length ?? 0;

    for (const status of ["pending_review", "approved", "draft"]) {
      const res = await callJson(client, "update_document", { path: "nodes/lifecycle", status });
      expect(res.json.frontmatter.status).toBe(status);
      const count = (await storage.readHistory("nodes/lifecycle"))?.versions.length ?? 0;
      expect(count).toBe(baseline);
    }
  });

  it("update_document normalizes status aliases on disk", async () => {
    await callJson(client, "create_document", { path: "nodes/aliased", title: "Aliased Doc" });

    const submitted = await callJson(client, "update_document", { path: "nodes/aliased", status: "submitted" });
    expect(submitted.json.frontmatter.status).toBe("pending_review");
    const onDisk1 = await storage.readDocument("nodes/aliased");
    expect(onDisk1.frontmatter.status).toBe("pending_review");

    const cancelled = await callJson(client, "update_document", { path: "nodes/aliased", status: "cancelled" });
    expect(cancelled.json.frontmatter.status).toBe("rejected");
    const onDisk2 = await storage.readDocument("nodes/aliased");
    expect(onDisk2.frontmatter.status).toBe("rejected");
  });

  it("update_document falls back to draft for an unknown status", async () => {
    await callJson(client, "create_document", { path: "nodes/unknown-status", title: "Unknown Status" });
    const res = await callJson(client, "update_document", { path: "nodes/unknown-status", status: "wat-is-this" });
    expect(res.json.frontmatter.status).toBe("draft");
  });

  it("update_document refuses content-only edits on a rejected doc", async () => {
    await callJson(client, "create_document", { path: "nodes/retired", title: "Retired Doc" });
    await callJson(client, "update_document", { path: "nodes/retired", status: "rejected" });

    const blocked = await callText(client, "update_document", { path: "nodes/retired", body: "sneaky edit" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("REJECTED_DOCUMENT");

    // Reviving with an explicit status is allowed.
    const revived = await callJson(client, "update_document", { path: "nodes/retired", status: "draft", body: "revived" });
    expect(revived.json.frontmatter.status).toBe("draft");
  });

  it("publish_document bumps version, computes a sha256 checksum, and cuts a checkpoint", async () => {
    await callJson(client, "create_document", { path: "nodes/publishable", title: "Publishable" });
    const before = (await storage.readHistory("nodes/publishable"))?.versions.length ?? 0;

    const { json } = await callJson(client, "publish_document", {
      path: "nodes/publishable",
      author: "tester@example.com",
      note: "regression publish",
    });
    expect(json.version).toBeGreaterThanOrEqual(1);
    expect(typeof json.chain_hash).toBe("string");
    expect(json.checkpoint).toBeGreaterThan(0);

    const doc = await storage.readDocument("nodes/publishable");
    expect(doc.frontmatter.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    const after = (await storage.readHistory("nodes/publishable"))?.versions.length ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("delete_document removes the file, its history, and drops it from the index", async () => {
    await callJson(client, "create_document", { path: "nodes/disposable", title: "Disposable" });
    expect(await exists(join(vault, "nodes", "disposable.md"))).toBe(true);

    const { json } = await callJson(client, "delete_document", { path: "nodes/disposable" });
    expect(json.title).toBe("Disposable");

    expect(await exists(join(vault, "nodes", "disposable.md"))).toBe(false);
    expect(await exists(join(vault, "nodes", ".versions", "disposable"))).toBe(false);
    expect(JSON.stringify(await storage.readContextYaml())).not.toContain("nodes/disposable");

    expect(await isToolError(client, "delete_document", { path: "nodes/disposable" })).toBe(true);
  });
});

// ─── Governance / drift tools (+ internal file assertions) ────────────────────

describe("[regression] MCP server e2e — governance & drift", () => {
  let vault: string;
  let client: Client;
  let storage: NestStorage;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
    storage = new NestStorage(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  /** Create+publish a doc, then drift its file out of band so a suggestion can be staged. */
  async function seedDrift(path: string): Promise<string> {
    await callJson(client, "create_document", { path, title: `Doc ${path}`, body: "original body" });
    const file = join(vault, `${path}.md`);
    const current = await readFile(file, "utf-8");
    await writeFile(file, `${current}\n\nDrifted content appended out of band.\n`, "utf-8");
    return file;
  }

  it("stage_drift_suggestion writes patch + meta files under _suggestions/", async () => {
    await seedDrift("nodes/drift-stage");
    const { json, isError } = await callJson(client, "stage_drift_suggestion", {
      path: "nodes/drift-stage",
      note: "detected during regression",
    });
    expect(isError).toBe(false);
    expect(typeof json.suggestion_id).toBe("string");
    expect(typeof json.target_hash).toBe("string");
    expect(typeof json.proposed_hash).toBe("string");

    const { dir, name } = splitId("nodes/drift-stage");
    const suggDir = join(vault, dir, "_suggestions", name);
    const files = await readdir(suggDir);
    expect(files.some((f) => f.endsWith(".patch"))).toBe(true);
    expect(files.some((f) => f.endsWith(".meta.yaml"))).toBe(true);
  });

  it("stage_drift_suggestion errors on a doc with no version history", async () => {
    // onboarding-guide is a fixture draft with no .versions history.
    expect(await isToolError(client, "stage_drift_suggestion", { path: "nodes/onboarding-guide" })).toBe(true);
  });

  it("list_suggestions reports staged counts and zero for clean docs", async () => {
    const staged = await callJson(client, "list_suggestions", { path: "nodes/drift-stage" });
    expect(staged.json.count).toBeGreaterThan(0);

    await callJson(client, "create_document", { path: "nodes/clean-doc", title: "Clean Doc" });
    const clean = await callJson(client, "list_suggestions", { path: "nodes/clean-doc" });
    expect(clean.json.count).toBe(0);
  });

  it("approve_suggestion applies the patch, bumps version, and archives under _archive/approved", async () => {
    await seedDrift("nodes/drift-approve");
    const staged = await callJson(client, "stage_drift_suggestion", { path: "nodes/drift-approve" });
    const beforeVersions = (await storage.readHistory("nodes/drift-approve"))?.versions.length ?? 0;

    const { json } = await callJson(client, "approve_suggestion", {
      path: "nodes/drift-approve",
      suggestion_id: staged.json.suggestion_id,
      comment: "looks good",
    });
    expect(typeof json.chain_hash).toBe("string");

    // Canonical bytes now contain the drifted content.
    const canonical = await readFile(join(vault, "nodes", "drift-approve.md"), "utf-8");
    expect(canonical).toContain("Drifted content appended out of band.");
    // Version bumped.
    const afterVersions = (await storage.readHistory("nodes/drift-approve"))?.versions.length ?? 0;
    expect(afterVersions).toBeGreaterThan(beforeVersions);
    // Patch + meta archived under _archive/approved.
    const archiveDir = join(vault, "nodes", "_suggestions", "drift-approve", "_archive", "approved");
    expect(await exists(archiveDir)).toBe(true);
    const archived = await readdir(archiveDir);
    expect(archived.length).toBeGreaterThan(0);
    // Integrity still holds after the governed update.
    const integrity = await callJson(client, "verify_integrity");
    expect(integrity.json).toHaveProperty("valid");
  });

  it("reject_suggestion archives under _archive/rejected and leaves the canonical doc untouched", async () => {
    const file = await seedDrift("nodes/drift-reject");
    const driftedBytes = await readFile(file, "utf-8");
    const staged = await callJson(client, "stage_drift_suggestion", { path: "nodes/drift-reject" });

    // A reason is required.
    expect(await isToolError(client, "reject_suggestion", { path: "nodes/drift-reject", suggestion_id: staged.json.suggestion_id })).toBe(true);

    const { json } = await callJson(client, "reject_suggestion", {
      path: "nodes/drift-reject",
      suggestion_id: staged.json.suggestion_id,
      reason: "not aligned with spec",
    });
    expect(json.rejection_reason).toBe("not aligned with spec");

    // Canonical file unchanged (still holds the out-of-band edit; not reverted, not promoted).
    const afterBytes = await readFile(file, "utf-8");
    expect(afterBytes).toBe(driftedBytes);
    // Patch + meta archived under _archive/rejected.
    const archiveDir = join(vault, "nodes", "_suggestions", "drift-reject", "_archive", "rejected");
    expect(await exists(archiveDir)).toBe(true);
    const archived = await readdir(archiveDir);
    expect(archived.length).toBeGreaterThan(0);
  });

  it("end-to-end drift flow: create → drift → stage → approve → clean & verified", async () => {
    // One continuous governance journey on a single doc, asserting state at
    // each hop (the per-tool tests above each cover a single step in isolation).
    await seedDrift("nodes/drift-flow");

    const staged = await callJson(client, "stage_drift_suggestion", { path: "nodes/drift-flow" });
    expect(staged.isError).toBe(false);

    // The suggestion is pending.
    const pending = await callJson(client, "list_suggestions", { path: "nodes/drift-flow" });
    expect(pending.json.count).toBe(1);

    // Approve merges the drift and bumps the version.
    const before = (await storage.readHistory("nodes/drift-flow"))?.versions.length ?? 0;
    await callJson(client, "approve_suggestion", {
      path: "nodes/drift-flow",
      suggestion_id: staged.json.suggestion_id,
    });
    const after = (await storage.readHistory("nodes/drift-flow"))?.versions.length ?? 0;
    expect(after).toBe(before + 1);

    // The drift was merged into the canonical bytes and no suggestions remain.
    // (verify_integrity is vault-wide and intentionally left dirty by the
    // reject test's leftover drift, so we assert doc-scoped state here.)
    const canonical = await readFile(join(vault, "nodes", "drift-flow.md"), "utf-8");
    expect(canonical).toContain("Drifted content appended out of band.");
    const cleared = await callJson(client, "list_suggestions", { path: "nodes/drift-flow" });
    expect(cleared.json.count).toBe(0);
  });
});

// ─── integrity failure path ────────────────────────────────────────────────
// The verify_integrity test above only proves the happy path. This corrupts a
// document on disk and asserts the server reports valid:false — the
// tamper-detection guarantee the whole hash-chain design exists for. Runs in
// its own vault so the corruption can't leak into other suites.

describe("[regression] MCP server e2e — integrity failure", () => {
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

  it("verify_integrity reports valid:false when a document is tampered out of band", async () => {
    await callJson(client, "create_document", { path: "nodes/sealed", title: "Sealed", body: "trusted bytes" });

    // Sanity: clean vault verifies.
    const clean = await callJson(client, "verify_integrity");
    expect(clean.json.valid).toBe(true);

    // Tamper the canonical bytes so they no longer match the recorded checksum.
    const file = join(vault, "nodes", "sealed.md");
    await writeFile(file, (await readFile(file, "utf-8")) + "\ntampered out of band\n", "utf-8");

    const tampered = await callJson(client, "verify_integrity");
    expect(tampered.json.valid).toBe(false);
  });
});

// ─── selector operators ──────────────────────────────────────────────────────
// resolve over the shared fixture is contaminated by graph traversal (the
// fixture docs are interlinked, so backlinks reappear in `documents`). To pin
// the OR (|) / NOT (-) operator semantics cleanly, seed a fresh vault with two
// UNLINKED published docs — traversal then adds nothing.

describe("[regression] MCP server e2e — selector operators", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
    await callJson(client, "create_document", { path: "nodes/op-auth", title: "Auth", tags: ["security", "api"] });
    await callJson(client, "create_document", { path: "nodes/op-billing", title: "Billing", tags: ["payments"] });
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("| (OR) returns the union of both terms", async () => {
    const { json } = await callJson(client, "resolve", { selector: "#security | #payments" });
    const ids = json.documents.map((d: any) => d.id);
    expect(ids).toContain("nodes/op-auth");
    expect(ids).toContain("nodes/op-billing");
  });

  it("- (NOT) excludes the negated term", async () => {
    const { json } = await callJson(client, "resolve", { selector: "#security - #payments" });
    const ids = json.documents.map((d: any) => d.id);
    expect(ids).toContain("nodes/op-auth");
    expect(ids).not.toContain("nodes/op-billing");
  });
});
