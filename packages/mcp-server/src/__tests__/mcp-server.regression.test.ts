/**
 * [regression] Black-box end-to-end tests for the Context Nest MCP server.
 *
 * Unlike mcp-server.test.ts (which re-implements handler logic against the engine
 * layer), this suite spawns the *real built server* (dist/index.js) and drives it
 * through a genuine MCP SDK Client over stdio. It exercises every one of the 20
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
  // Catalog-driven: name, description and schema come from the engine's
  // operation catalog rather than being declared here, so this surface cannot
  // drift from the CLI's. The legacy twin of a catalog tool (e.g.
  // create_document) stays registered but is deprecated.
  "context_get",
  "context_query",
  "context_resolve",
  "context_list",
  "context_folders",
  "context_search",
  "context_create",
  "context_update",
  "context_publish",
  "context_delete",
  "context_versions",
  "context_reconstruct",
  "context_verify",
  "context_forget",
  "context_forget_log",
  "context_init",
  "context_packs",
  "context_import",
  "context_import_pdf",
  "context_nests",
  "context_skill",
  "context_skill_install",
  // Hand-written, still current.
  "document_format",
  "read_index",
  "read_pack",
  "list_checkpoints",
  "stage_drift_suggestion",
  "list_suggestions",
  "approve_suggestion",
  "reject_suggestion",
  "context_review",
  // Legacy names — kept as deprecated aliases for the migration window.
  "vault_info",
  "resolve",
  "read_document",
  "list_documents",
  "search",
  "verify_integrity",
  "read_version",
  "create_document",
  "update_document",
  "delete_document",
  "publish_document",
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
  //
  // The override is applied AFTER the copy: a developer who has
  // CONTEXTNEST_VAULT_PATH or CTX_NEST_HOME exported for their own vault would
  // otherwise have it copied over the throwaway one, and the suite would run —
  // and write — against their real vault.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  delete env.CTX_NEST_HOME;
  env.CONTEXTNEST_VAULT_PATH = vaultPath;

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

  it(`exposes exactly the ${EXPECTED_TOOLS.length} expected tools, each with a description and input schema`, async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });

  // A catalog tool is registered from `op.input.shape`, which is undefined on
  // any descriptor whose input is a ZodEffects (i.e. one carrying a `.refine`).
  // The SDK accepts that and publishes a tool advertising NO parameters at all,
  // so a client cannot tell what to send — and asserting only that inputSchema
  // "is defined" above sails straight past it.
  it.each([
    ["context_create", ["title", "content"]],
    ["context_update", ["id", "content", "status"]],
    ["context_list", ["type", "tag", "status", "limit"]],
    ["context_versions", ["id", "title", "include_diff"]],
    ["context_get", ["uri", "id", "title", "include_raw", "allow_rejected"]],
    ["context_init", ["include_nodes", "limit"]],
    ["context_search", ["query", "limit"]],
    ["context_query", ["query", "hops", "full", "include_drafts"]],
    ["context_resolve", ["selector", "max_tokens", "hops"]],
    ["context_import", ["documents", "ids"]],
    ["context_import_pdf", ["bytes_base64", "id", "title", "folder", "tags", "publish"]],
  ])("%s advertises its declared inputs", async (name, expected) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    const props = Object.keys(
      (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(props).toEqual(expect.arrayContaining(expected));
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
      expect.arrayContaining(["document", "skill", "source", "snippet", "glossary", "persona", "prompt", "tool", "reference", "pdf"]),
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

  it("create_document round-trips a source node's block, and refuses one without it", async () => {
    const source = { transport: "mcp", server: "harvest", tools: ["list_projects"] };
    const { json } = await callJson(client, "create_document", {
      path: "nodes/my-source",
      title: "My Source",
      type: "source",
      source,
    });
    expect(json.frontmatter.type).toBe("source");
    expect(json.frontmatter.source).toEqual(source);

    // Rule 9: without a block the create fails outright and leaves nothing behind.
    const bare = await callText(client, "create_document", {
      path: "nodes/no-block",
      title: "No Block",
      type: "source",
    });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain("rule 9");
    expect(await exists(join(vault, "nodes", "no-block.md"))).toBe(false);
  });

  it("update_document can edit a source block and re-type a node", async () => {
    const replacement = { transport: "rest", server: "bigearnie", tools: ["get_estimate"] };
    const edited = await callJson(client, "update_document", {
      path: "nodes/my-source",
      source: replacement,
    });
    expect(edited.json.frontmatter.source).toEqual(replacement);

    // Rule 17 both ways: the block goes when the type does, and comes back with it.
    const plain = await callJson(client, "update_document", {
      path: "nodes/my-source",
      type: "document",
    });
    expect(plain.json.frontmatter.type).toBe("document");
    expect(plain.json.frontmatter.source).toBeUndefined();

    const back = await callJson(client, "update_document", {
      path: "nodes/my-source",
      type: "source",
      source: replacement,
    });
    expect(back.json.frontmatter.source).toEqual(replacement);
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

  it("publish and delete rewrite only the touched folder's INDEX.md", async () => {
    for (const path of ["nodes/scope-a/one", "nodes/scope-a/two", "nodes/scope-b/three"]) {
      await callJson(client, "create_document", { path, title: path.split("/").pop() });
    }
    const otherIndex = join(vault, "nodes", "scope-b", "INDEX.md");
    const before = await readFile(otherIndex, "utf-8");
    await new Promise((r) => setTimeout(r, 5));

    await callJson(client, "publish_document", { path: "nodes/scope-a/one", author: "t@example.com" });
    await callJson(client, "delete_document", { path: "nodes/scope-a/two" });

    expect(await readFile(otherIndex, "utf-8")).toBe(before);
    const touched = await readFile(join(vault, "nodes", "scope-a", "INDEX.md"), "utf-8");
    expect(touched).toContain("nodes/scope-a/one");
    expect(touched).not.toContain("nodes/scope-a/two");
    expect(JSON.stringify(await storage.readContextYaml())).not.toContain("nodes/scope-a/two");
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

  it("context_get still serves the tampered document, flagged with the integrity warning (NestBench T10)", async () => {
    // Runs after the tamper above: nodes/sealed no longer matches its checksum.
    const { json } = await callJson(client, "context_get", { id: "nodes/sealed" });
    expect(json.body).toContain("tampered out of band");
    expect(json.integrity?.status).toBe("failed");
    expect(json.integrity?.checks).toContain("body_drift");
    expect(json.integrity?.warning).toMatch(/^⚠ Integrity check failed/);
  });

  it("context_list full flags the tampered body; read_version flags a broken chain in its text", async () => {
    const { json } = await callJson(client, "context_list", { full: true });
    const sealed = json.documents.find((d: any) => d.id === "nodes/sealed");
    expect(sealed.integrity?.status).toBe("failed");

    // A doc whose keyframe is altered before anything read it in this server.
    await callJson(client, "create_document", { path: "nodes/chained", title: "Chained", body: "v1 bytes" });
    const versionsDir = join(vault, "nodes", ".versions", "chained");
    const keyframe = (await readdir(versionsDir)).find((f) => /^v\d+\.md$/.test(f))!;
    const kfPath = join(versionsDir, keyframe);
    await writeFile(kfPath, (await readFile(kfPath, "utf-8")).replace("v1 bytes", "forged"), "utf-8");
    const version = Number(keyframe.slice(1, -3));
    const { text } = await callText(client, "read_version", { path: "nodes/chained", version });
    expect(text).toMatch(/^⚠ Integrity check failed/);
  });

  it("an intact document is served with no integrity key", async () => {
    await callJson(client, "create_document", { path: "nodes/clean", title: "Clean", body: "fine" });
    const { json } = await callJson(client, "context_get", { id: "nodes/clean" });
    expect(json).not.toHaveProperty("integrity");
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

// Keyframe tampering is the deeper case: the canonical file and history.yaml
// metadata are left intact, so detection requires re-hashing the version
// keyframe bytes. Runs in its own vault (a sibling tamper would leave the
// shared vault permanently invalid and mask the clean baseline).
describe("[regression] MCP server e2e — integrity failure (keyframe)", () => {
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

  it("verify_integrity reports valid:false when a version keyframe is tampered", async () => {
    await callJson(client, "create_document", { path: "nodes/archived", title: "Archived", body: "trusted history" });

    const clean = await callJson(client, "verify_integrity");
    expect(clean.json.valid).toBe(true);

    // Tamper whichever v{N}.md keyframe the history actually references
    // (the create+publish path may land on v2, not v1).
    const verDir = join(vault, "nodes", ".versions", "archived");
    const keyframeFile = (await readdir(verDir)).find((f) => /^v\d+\.md$/.test(f));
    expect(keyframeFile).toBeDefined();
    const keyframe = join(verDir, keyframeFile!);
    await writeFile(keyframe, (await readFile(keyframe, "utf-8")) + "\nrewritten history\n", "utf-8");

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

describe("[regression] MCP server e2e — misnamed parameters cannot silently drop a write", () => {
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

  it("advertises additionalProperties:false and actually enforces it", async () => {
    const { tools } = await client.listTools();
    const update = tools.find((t) => t.name === "update_document")!;
    expect((update.inputSchema as any).additionalProperties).toBe(false);

    await callJson(client, "create_document", {
      path: "nodes/strict-doc",
      title: "Strict Doc",
      body: "the original body",
    });

    // `contents` is not a parameter. Previously zod stripped it, the tool
    // answered "Document updated and published successfully", the version
    // bumped, and the body on disk was untouched.
    const rejected = await callText(client, "update_document", {
      path: "nodes/strict-doc",
      contents: "the rewrite",
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/contents/);

    const { json } = await callJson(client, "read_document", { uri: "nodes/strict-doc" });
    expect(json.body).toContain("the original body");
    expect(json.body).not.toContain("the rewrite");
  });

  it("accepts `content` as an alias for `body` on create and update", async () => {
    await callJson(client, "create_document", {
      path: "nodes/alias-doc",
      title: "Alias Doc",
      content: "created through content",
    });
    let doc = await callJson(client, "read_document", { uri: "nodes/alias-doc" });
    expect(doc.json.body).toContain("created through content");

    await callJson(client, "update_document", {
      path: "nodes/alias-doc",
      content: "updated through content",
    });
    doc = await callJson(client, "read_document", { uri: "nodes/alias-doc" });
    expect(doc.json.body).toContain("updated through content");
  });

  it("refuses `body` and `content` carrying different text rather than picking one", async () => {
    const { isError, json } = await callJson(client, "create_document", {
      path: "nodes/alias-conflict",
      title: "Conflict",
      body: "one",
      content: "two",
    });
    expect(isError).toBe(true);
    expect(json.code).toBe("VALIDATION_FAILED");
  });

  it("sets and clears a description through create_document and update_document", async () => {
    await callJson(client, "create_document", {
      path: "nodes/described-doc",
      title: "Described Doc",
      description: "what this document is for",
      body: "body",
    });
    let doc = await callJson(client, "read_document", { uri: "nodes/described-doc" });
    expect(doc.json.frontmatter.description).toBe("what this document is for");

    await callJson(client, "update_document", {
      path: "nodes/described-doc",
      description: "a sharper summary",
    });
    doc = await callJson(client, "read_document", { uri: "nodes/described-doc" });
    expect(doc.json.frontmatter.description).toBe("a sharper summary");

    await callJson(client, "update_document", { path: "nodes/described-doc", description: "" });
    doc = await callJson(client, "read_document", { uri: "nodes/described-doc" });
    expect(doc.json.frontmatter.description).toBeUndefined();
  });

  it("filters list_documents by path, on segment boundaries", async () => {
    await callJson(client, "create_document", { path: "nodes/history/q1", title: "Q1" });
    await callJson(client, "create_document", { path: "nodes/history/q2", title: "Q2" });
    await callJson(client, "create_document", { path: "nodes/historic-note", title: "Historic" });

    const { json } = await callJson(client, "list_documents", { path: "nodes/history" });
    const ids = json.map((d: any) => d.id);
    expect(ids).toContain("nodes/history/q1");
    expect(ids).toContain("nodes/history/q2");
    // "nodes/historic-note" shares the prefix but not the segment.
    expect(ids).not.toContain("nodes/historic-note");
  });

  it("composes the path filter with the other list filters", async () => {
    const { json } = await callJson(client, "list_documents", {
      path: "nodes/history",
      status: "published",
    });
    expect(json.length).toBeGreaterThan(0);
    for (const doc of json) {
      expect(doc.id.startsWith("nodes/history/")).toBe(true);
      expect(doc.status).toBe("published");
    }
  });

  it("refuses a misnamed key INSIDE a source block, on create and on update", async () => {
    // The tool() helper's strictness stops at the top level, so this holds only
    // because the nested source schema is strict too. A dropped `server` would
    // write a block missing the field rule 12 wants, and seal it into the chain.
    const typo = { transport: "mcp", servers: "TYPO", tools: ["list_projects"] };
    const badCreate = await callText(client, "create_document", {
      path: "nodes/typo-source",
      title: "Typo Source",
      type: "source",
      source: typo,
    });
    expect(badCreate.isError).toBe(true);
    expect(badCreate.text).toMatch(/servers/);
    expect(await exists(join(vault, "nodes", "typo-source.md"))).toBe(false);

    const source = { transport: "mcp", server: "harvest", tools: ["list_projects"] };
    await callJson(client, "create_document", {
      path: "nodes/good-source",
      title: "Good Source",
      type: "source",
      source,
    });
    const badUpdate = await callText(client, "update_document", {
      path: "nodes/good-source",
      source: typo,
    });
    expect(badUpdate.isError).toBe(true);
    expect(badUpdate.text).toMatch(/servers/);

    const { json } = await callJson(client, "read_document", { uri: "nodes/good-source" });
    expect(json.frontmatter.source).toEqual(source);
  });
});

// ─── context_import_pdf (CU-wdqcq02pmg) ──────────────────────────────────────

describe("[regression] MCP server e2e — context_import_pdf", () => {
  let vault: string;
  let client: Client;
  const PDF = fileURLToPath(new URL("../../../../fixtures/pdf/report.pdf", import.meta.url));

  beforeAll(async () => {
    vault = await freshVault();
    client = await connect(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("imports a PDF over the wire: node + sidecar on disk, verify clean", async () => {
    const bytes = await readFile(PDF);
    const { json, isError } = await callJson(client, "context_import_pdf", {
      bytes_base64: bytes.toString("base64"),
      folder: "reports",
    });
    expect(isError).toBe(false);
    expect(json.created).toBe(true);
    expect(json.id).toBe("nodes/reports/quarterly-report");
    expect(json.text_layer).toBe(true);
    expect(json.pdf.pages).toBe(2);
    expect(await readFile(join(vault, json.pdf.file))).toEqual(bytes);

    const got = await callJson(client, "context_get", { id: json.id });
    expect(got.json.frontmatter.type).toBe("pdf");
    expect(got.json.body).toContain("Revenue grew 12 percent.");

    const verify = await callJson(client, "context_verify", {});
    expect(verify.json.valid).toBe(true);
  });
});

// ─── Review gate ──────────────────────────────────────────────────────────────

describe("[regression] MCP server e2e — review gate", () => {
  let vault: string;
  let client: Client;

  beforeAll(async () => {
    vault = await freshVault();
    // The fixture predates the gate (no key); turn it on the way `ctx init` does.
    const cfg = join(vault, ".context", "config.yaml");
    await writeFile(cfg, `${await readFile(cfg, "utf-8")}\nreview: 'on'\n`);
    client = await connect(vault);
  });

  afterAll(async () => {
    await client.close();
    await rm(vault, { recursive: true, force: true });
  });

  it("holds context_create and tells the agent the user can turn review off", async () => {
    const { json, isError } = await callJson(client, "context_create", {
      title: "Held Note",
      content: "agent-written",
    });
    expect(isError).toBe(false);
    expect(json.held_for_review).toBe(true);
    expect(json.status).toBe("pending_review");
    expect(json.checkpoint).toBeNull();
    expect(json.review).toMatch(/pending review/);
    expect(json.review).toMatch(/turn off review/);
  });

  it("context_review approve publishes the held node", async () => {
    const { json } = await callJson(client, "context_review", { action: "approve", id: "nodes/held-note" });
    expect(json.id).toBe("nodes/held-note");
    expect(json.version).toBeGreaterThanOrEqual(1);
    const raw = await readFile(join(vault, "nodes", "held-note.md"), "utf-8");
    expect(raw).toMatch(/status:\s*published/);
  });

  it("an edit to a published node is staged; the published body keeps serving", async () => {
    const { json } = await callJson(client, "context_update", { id: "nodes/held-note", content: "edited" });
    expect(json.held_for_review).toBe(true);
    expect(typeof json.suggestion_id).toBe("string");
    const raw = await readFile(join(vault, "nodes", "held-note.md"), "utf-8");
    expect(raw).toContain("agent-written");
    expect(raw).not.toContain("edited");
  });

  it("a create that names a status is still held — status alone never stops a create publishing", async () => {
    const { json } = await callJson(client, "context_create", { title: "Named Status", content: "x", status: "draft" });
    expect(json.held_for_review).toBe(true);
    expect(json.status).toBe("pending_review");
    expect(json.checkpoint).toBeNull();
  });

  it("the deprecated create_document is held too — the legacy tool is no way around the gate", async () => {
    const { json, isError } = await callJson(client, "create_document", { path: "nodes/legacy-held", title: "Legacy Held" });
    expect(isError).toBe(false);
    expect(json.held_for_review).toBe(true);
    expect(json.review).toMatch(/turn off review/);
    const raw = await readFile(join(vault, "nodes", "legacy-held.md"), "utf-8");
    expect(raw).toMatch(/status:\s*pending_review/);
    expect(await new NestStorage(vault).readHistory("nodes/legacy-held")).toBeNull();
  });

  it("the deprecated update_document stages an edit to a published node and builds on the prior hold", async () => {
    const { json } = await callJson(client, "update_document", { path: "nodes/held-note", body: "legacy edit" });
    expect(json.held_for_review).toBe(true);
    expect(typeof json.suggestion_id).toBe("string");
    const raw = await readFile(join(vault, "nodes", "held-note.md"), "utf-8");
    expect(raw).toContain("agent-written");
    // One hold per node: this one superseded context_update's.
    const list = await callJson(client, "context_review", { action: "list" });
    expect(list.json.filter((i: { id: string }) => i.id === "nodes/held-note")).toHaveLength(1);
    await callJson(client, "context_review", { action: "approve", id: "nodes/held-note" });
    expect(await readFile(join(vault, "nodes", "held-note.md"), "utf-8")).toContain("legacy edit");
  });

  it("context_review off turns the gate off; the next write publishes", async () => {
    const off = await callJson(client, "context_review", { action: "off" });
    expect(off.json.review).toBe("off");
    const { json } = await callJson(client, "context_create", { title: "After Off", content: "x" });
    expect(json.held_for_review).toBeUndefined();
    expect(json.status).toBe("published");
  });
});

// ─── context_search & context_query ───────────────────────────────────────────
//
// Fixture statuses: api-design, architecture-overview and both sources are
// published; onboarding-guide is a draft, schema-migration approved,
// legacy-soap-bridge rejected. Only the published ones may ever be served.

const NEVER_SERVED = ["nodes/onboarding-guide", "nodes/schema-migration", "nodes/legacy-soap-bridge"];

describe("[regression] MCP server e2e — context_search", () => {
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

  const search = async (args: Record<string, unknown>) => {
    const { json, isError } = await callJson(client, "context_search", args);
    expect(isError, JSON.stringify(args)).toBe(false);
    return json as { results: Array<{ id: string; title: string; score?: number }>; count: number; total: number };
  };
  const ids = async (query: string) => (await search({ query })).results.map((r) => r.id);

  it("finds a published doc by body text, scored, best hit first", async () => {
    const res = await search({ query: "authentication" });
    expect(res.results[0].id).toBe("nodes/api-design");
    expect(res.results[0].title).toBe("API Design Guidelines");
    const scores = res.results.map((r) => r.score!);
    expect(scores.every((s) => typeof s === "number")).toBe(true);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(res.total).toBe(res.results.length);
  });

  it("matches title, tags and source nodes, case-insensitively", async () => {
    expect((await ids("Architecture Overview"))[0]).toBe("nodes/architecture-overview");
    expect(await ids("guidelines")).toContain("nodes/api-design");
    expect(await ids("sprint")).toContain("sources/sprint-tickets");
    expect((await ids("AUTHENTICATION"))[0]).toBe("nodes/api-design");
  });

  it("ranks a doc matching every term above partial matches", async () => {
    expect((await ids("API gateway"))[0]).toBe("nodes/architecture-overview");
  });

  it("never returns draft, approved or rejected docs", async () => {
    for (const q of ["Onboarding", "migration", "SOAP", "engineering"]) {
      const got = await ids(q);
      for (const hidden of NEVER_SERVED) expect(got, q).not.toContain(hidden);
    }
  });

  it("limit caps results while count still counts every match", async () => {
    const all = await search({ query: "API" });
    expect(all.count).toBeGreaterThan(1);
    expect(all.count).toBe(all.results.length);
    const one = await search({ query: "API", limit: 1 });
    expect(one.results).toHaveLength(1);
    expect(one.results[0].id).toBe(all.results[0].id);
    expect(one.count).toBe(all.count);
    // Deprecated alias, same value.
    expect(one.total).toBe(one.count);
  });

  it("no match and a whitespace-only query return empty results, not an error", async () => {
    expect(await search({ query: "zzqx-no-such-term" })).toEqual({ results: [], count: 0, total: 0 });
    expect(await search({ query: "   " })).toEqual({ results: [], count: 0, total: 0 });
  });

  it("special characters in the query never break the search", async () => {
    const queries = ["c++", "\"quoted phrase\"", "API-design", "#engineering", "contextnest://nodes/x", "(", "a|b -c", "50%", "ünïcödé"];
    for (const q of queries) {
      const { json, isError } = await callJson(client, "context_search", { query: q });
      expect(isError, q).toBe(false);
      expect(Array.isArray(json.results), q).toBe(true);
    }
  });

  it("rejects a missing or empty query, a non-positive limit and unknown keys", async () => {
    expect(await isToolError(client, "context_search", {})).toBe(true);
    expect(await isToolError(client, "context_search", { query: "" })).toBe(true);
    expect(await isToolError(client, "context_search", { query: "API", limit: 0 })).toBe(true);
    expect(await isToolError(client, "context_search", { query: "API", limit: -1 })).toBe(true);
    expect(await isToolError(client, "context_search", { query: "API", hops: 2 })).toBe(true);
  });

  it("sees a create at once, an update's new text only, and nothing after a delete", async () => {
    const { json: created } = await callJson(client, "context_create", {
      title: "Search Freshness",
      content: "The token PAPAYAUNIQUE marks this note.",
    });
    expect(await ids("PAPAYAUNIQUE")).toContain(created.id);

    await callJson(client, "context_update", { id: created.id, content: "Now it says GUAVAUNIQUE instead." });
    expect(await ids("PAPAYAUNIQUE")).not.toContain(created.id);
    expect(await ids("GUAVAUNIQUE")).toContain(created.id);

    await callJson(client, "context_delete", { id: created.id });
    expect(await ids("GUAVAUNIQUE")).not.toContain(created.id);
  });

  it("does not return an unpublished draft or a forgotten node", async () => {
    const { json: draft } = await callJson(client, "context_create", {
      title: "Search Draft",
      content: "Draft text with KIWIDRAFTUNIQUE inside.",
      publish: false,
    });
    expect(await ids("KIWIDRAFTUNIQUE")).not.toContain(draft.id);

    const { json: gone } = await callJson(client, "context_create", {
      title: "Search Forgotten",
      content: "Erasable text with MANGOFORGETUNIQUE inside.",
    });
    expect(await ids("MANGOFORGETUNIQUE")).toContain(gone.id);
    const forgot = await callText(client, "context_forget", { id: gone.id, reason_code: "user_request" });
    expect(forgot.isError, forgot.text).toBe(false);
    expect(await ids("MANGOFORGETUNIQUE")).toEqual([]);
  });

  it("the deprecated `search` alias still finds documents", async () => {
    const { json, isError } = await callJson(client, "search", { query: "authentication" });
    expect(isError).toBe(false);
    expect(json.documents.map((d: any) => d.id)).toContain("nodes/api-design");
  });
});

describe("[regression] MCP server e2e — context_query", () => {
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

  type QueryResult = {
    documents: Array<{ id: string; type: string; status: string; body?: string }>;
    source_nodes?: Array<{ id: string; type: string }>;
    traversal: { mode: string; hops_used: number; nodes_traversed: number };
  };
  const query = async (args: Record<string, unknown>) => {
    const { json, isError } = await callJson(client, "context_query", args);
    expect(isError, JSON.stringify(args)).toBe(false);
    return json as QueryResult;
  };
  const docIds = async (q: string, extra: Record<string, unknown> = {}) =>
    (await query({ query: q, ...extra })).documents.map((d) => d.id).sort();

  it("a tag selector returns matching docs with bodies and traversal stats", async () => {
    const res = await query({ query: "#api" });
    expect(res.documents.map((d) => d.id)).toContain("nodes/api-design");
    expect(typeof res.documents[0].body).toBe("string");
    expect(res.traversal.mode).toBe("graph");
    expect(typeof res.traversal.hops_used).toBe("number");
    expect(typeof res.traversal.nodes_traversed).toBe("number");
  });

  it("type:source returns sources under source_nodes, not documents", async () => {
    const res = await query({ query: "type:source", hops: 0 });
    expect(res.source_nodes!.map((d) => d.id).sort()).toEqual([
      "sources/active-project-config",
      "sources/sprint-tickets",
    ]);
    expect(res.documents.filter((d) => d.type === "source")).toEqual([]);
  });

  it("serves only published docs, whatever the selector or mode", async () => {
    for (const q of ["#engineering", "type:document", "status:published", "#onboarding", "#database", "#legacy"]) {
      for (const full of [false, true]) {
        const got = await docIds(q, { full, hops: 3 });
        for (const hidden of NEVER_SERVED) expect(got, `${q} full=${full}`).not.toContain(hidden);
      }
    }
    const published = await query({ query: "status:published", hops: 0 });
    expect(published.documents.every((d) => d.status === "published")).toBe(true);
  });

  it("AND by space and by + agree", async () => {
    const spaced = await docIds("#engineering type:document", { hops: 0 });
    expect(spaced).toEqual(["nodes/api-design", "nodes/architecture-overview"]);
    expect(await docIds("#engineering + type:document", { hops: 0 })).toEqual(spaced);
  });

  it("| unions, - excludes and parentheses group", async () => {
    expect(await docIds("#api | #architecture", { hops: 0 })).toEqual([
      "nodes/api-design",
      "nodes/architecture-overview",
    ]);
    expect(await docIds("#engineering -#api", { hops: 0 })).toEqual(["nodes/architecture-overview"]);
    expect(await docIds("(#api | #architecture) -#api", { hops: 0 })).toEqual(["nodes/architecture-overview"]);
  });

  it("a pack selector expands its query and includes", async () => {
    const got = await docIds("pack:onboarding.basics", { hops: 0 });
    expect(got).toContain("nodes/architecture-overview");
    expect(got).not.toContain("nodes/onboarding-guide"); // draft
  });

  it("URI, bare node id and search URI selectors resolve", async () => {
    expect(await docIds("contextnest://nodes/api-design", { hops: 0 })).toEqual(["nodes/api-design"]);
    expect(await docIds("nodes/api-design", { hops: 0 })).toEqual(["nodes/api-design"]);
    expect(await docIds("contextnest://search/authentication", { hops: 0 })).toContain("nodes/api-design");
  });

  it("hops widens the result along links; hops 0 returns only the seed", async () => {
    expect(await docIds("contextnest://nodes/api-design", { hops: 0 })).toEqual(["nodes/api-design"]);
    expect(await docIds("contextnest://nodes/api-design", { hops: 1 })).toEqual([
      "nodes/api-design",
      "nodes/architecture-overview",
    ]);
  });

  it("full:true runs full mode and serves the same seed", async () => {
    const res = await query({ query: "#api", full: true });
    expect(res.traversal.mode).toBe("full");
    expect(res.documents.map((d) => d.id)).toContain("nodes/api-design");
  });

  it("include_drafts surfaces a draft but never an approved or rejected doc", async () => {
    expect(await docIds("#onboarding")).toEqual([]);
    expect(await docIds("#onboarding", { include_drafts: true })).toContain("nodes/onboarding-guide");
    expect(await docIds("#database", { include_drafts: true })).not.toContain("nodes/schema-migration");
    expect(await docIds("#legacy", { include_drafts: true })).not.toContain("nodes/legacy-soap-bridge");
  });

  it("a selector matching nothing returns an empty list, not an error", async () => {
    expect(await docIds("#no-such-tag-anywhere")).toEqual([]);
  });

  it("refuses a malformed selector, an empty query, negative hops and unknown keys", async () => {
    expect(await isToolError(client, "context_query", { query: "#api +" })).toBe(true);
    expect(await isToolError(client, "context_query", { query: "(#api" })).toBe(true);
    expect(await isToolError(client, "context_query", {})).toBe(true);
    expect(await isToolError(client, "context_query", { query: "" })).toBe(true);
    expect(await isToolError(client, "context_query", { query: "#api", hops: -1 })).toBe(true);
    expect(await isToolError(client, "context_query", { query: "#api", limit: 5 })).toBe(true);
  });

  it("sees a create and a retag at once in graph mode", async () => {
    const { json: created } = await callJson(client, "context_create", {
      title: "Query Freshness",
      content: "fresh body",
      tags: ["#freshtag"],
    });
    expect(await docIds("#freshtag")).toEqual([created.id]);
    await callJson(client, "context_update", { id: created.id, tags: ["#retagged"] });
    expect(await docIds("#freshtag")).toEqual([]);
    expect(await docIds("#retagged")).toEqual([created.id]);
  });

  it("hides a forgotten node unless status:forgotten is asked for by name", async () => {
    const { json: created } = await callJson(client, "context_create", {
      title: "Query Forgotten",
      content: "content that will be erased by a forget",
      tags: ["#forgetme"],
    });
    const forgot = await callText(client, "context_forget", { id: created.id, reason_code: "user_request" });
    expect(forgot.isError, forgot.text).toBe(false);
    expect(await docIds("#forgetme")).toEqual([]);
    expect(await docIds("#forgetme", { full: true })).toEqual([]);
    const stub = await query({ query: "status:forgotten" });
    expect(stub.documents.map((d) => d.id)).toEqual([created.id]);
    expect(stub.documents[0].body?.trim()).toBe("");
  });

  it("the deprecated `resolve` alias returns what context_query returns", async () => {
    const { json, isError } = await callJson(client, "resolve", { selector: "#engineering", hops: 1 });
    expect(isError).toBe(false);
    expect(json.documents.map((d: any) => d.id).sort()).toEqual(await docIds("#engineering", { hops: 1 }));
  });
});
