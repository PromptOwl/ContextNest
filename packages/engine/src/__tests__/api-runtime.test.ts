import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { z } from "zod";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { UnauthorizedActionError } from "../errors.js";
import type { ContextNode } from "../types.js";
import {
  createEngineApi,
  OPERATIONS,
  type OperationContext,
  type EngineExtension,
  type OperationDescriptor,
} from "../api/index.js";
import { addVault, setDefaultVault } from "../registry.js";

async function makeContext(): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-api-runtime-"));
  const storage = new NestStorage(dir);
  return {
    dir,
    ctx: {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    },
  };
}

describe("createEngineApi — executable core operations", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("create → get → list → update runs against the real engine", async () => {
    const api = createEngineApi();

    const created = await api.run<{ id: string; version: number }>(
      "context_create",
      { title: "API Design", content: "# API Design\n\nBody.", tags: ["#api"] },
      ctx,
    );
    expect(created.id).toContain("api-design");
    expect(created.version).toBeGreaterThanOrEqual(1);

    const got = await api.run<{ id: string; body: string }>(
      "context_get",
      { id: created.id },
      ctx,
    );
    expect(got.body).toContain("Body.");

    const listed = await api.run<{ documents: Array<{ id: string }> }>(
      "context_list",
      {},
      ctx,
    );
    expect(listed.documents.some((d) => d.id === created.id)).toBe(true);

    const updated = await api.run<{ version: number }>(
      "context_update",
      { id: created.id, append: "Appended line." },
      ctx,
    );
    expect(updated.version).toBeGreaterThan(created.version);
    const after = await api.run<{ body: string }>("context_get", { id: created.id }, ctx);
    expect(after.body).toContain("Appended line.");
  });

  it("create with a folder stays discoverable under nodes/ (regression: C1)", async () => {
    const api = createEngineApi();
    const created = await api.run<{ id: string }>(
      "context_create",
      { title: "Big Deal", content: "body", folder: "gtm/deals" },
      ctx,
    );
    expect(created.id).toBe("nodes/gtm/deals/big-deal");
    const listed = await api.run<{ documents: Array<{ id: string }> }>("context_list", {}, ctx);
    expect(listed.documents.some((d) => d.id === created.id)).toBe(true);
  });

  it("title selects the real doc, and on update it renames instead (regression: C2)", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "My Cool Title", content: "orig" }, ctx);
    // Selecting by title still resolves the real doc rather than a slug guess —
    // the C2 guard, now carried by the selector ops that kept that input.
    const got = await api.run<{ id: string }>("context_get", { title: "My Cool Title" }, ctx);
    expect(got.id).toBe("nodes/my-cool-title");
    // On context_update `title` is the NEW title: it renames, leaving the id be.
    const updated = await api.run<{ id: string }>(
      "context_update",
      { id: got.id, title: "Renamed", append: "more" },
      ctx,
    );
    expect(updated.id).toBe("nodes/my-cool-title");
    const after = await api.run<{ frontmatter: { title: string }; body: string }>(
      "context_get",
      { id: got.id },
      ctx,
    );
    expect(after.frontmatter.title).toBe("Renamed");
    expect(after.body).toContain("more");
  });

  it("rejects a title with nothing slug-able on create AND on rename", async () => {
    const api = createEngineApi();
    await expect(
      api.run("context_create", { title: "###", content: "body" }, ctx),
    ).rejects.toThrow(/no slug-able/);

    const doc = await api.run<{ id: string }>(
      "context_create",
      { title: "Real Title", content: "body" },
      ctx,
    );
    // A rename keeps the id, but an unusable title is still unusable — title→id
    // resolution, search and wiki links all read it back.
    await expect(
      api.run("context_update", { id: doc.id, title: "..." }, ctx),
    ).rejects.toThrow(/no letter or number/);
  });

  it("keeps a non-Latin title renameable when the id was supplied explicitly", async () => {
    const api = createEngineApi();
    // Slugifies to nothing, so create only accepts it alongside an explicit id —
    // and update must then apply the same rule, or the document is stuck with a
    // title it can never re-save.
    const doc = await api.run<{ id: string }>(
      "context_create",
      { title: "日本語のみ", content: "body", id: "nodes/system/jp" },
      ctx,
    );
    await api.run("context_update", { id: doc.id, title: "日本語のみ", content: "more" }, ctx);
    const after = await api.run<{ frontmatter: { title: string } }>(
      "context_get",
      { id: doc.id },
      ctx,
    );
    expect(after.frontmatter.title).toBe("日本語のみ");
  });

  it("published doc is visible to graph-mode query after create (regression: S3 index regen)", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Findable", content: "body", tags: ["#api"] }, ctx);
    const result = await api.run<{ documents: Array<{ id: string }> }>(
      "context_query",
      { query: "#api" },
      ctx,
    );
    expect(result.documents.some((d) => d.id === "nodes/findable")).toBe(true);
  });

  it("search returns published matches via the engine resolver (S1)", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Searchable Widget", content: "gizmo body" }, ctx);
    const out = await api.run<{ results: Array<{ id: string }> }>(
      "context_search",
      { query: "gizmo" },
      ctx,
    );
    expect(out.results.some((r) => r.id === "nodes/searchable-widget")).toBe(true);
  });

  it("context_create refuses to overwrite an existing doc", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Dup Node", content: "first" }, ctx);
    await expect(
      api.run("context_create", { title: "Dup Node", content: "second" }, ctx),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
    // Original body must survive the rejected second create.
    const got = await api.run<{ body: string }>("context_get", { id: "nodes/dup-node" }, ctx);
    expect(got.body.trim()).toBe("first");
  });

  it("context_create cannot resurrect a rejected doc", async () => {
    const rejected: ContextNode = {
      id: "nodes/retired",
      filePath: "",
      rawContent: "",
      frontmatter: { title: "Retired", status: "rejected" },
      body: "retired body",
    };
    await ctx.storage.writeDocument("nodes/retired", serializeDocument(rejected));

    const api = createEngineApi();
    // Same title → same id; must be refused rather than overwritten to draft+published.
    await expect(
      api.run("context_create", { title: "Retired", content: "fresh" }, ctx),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
    const afterFile = await ctx.storage.readDocument("nodes/retired");
    expect(afterFile.frontmatter.status).toBe("rejected");
    expect(afterFile.body.trim()).toBe("retired body");
  });

  it("context_search survives a query containing slashes", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Url Doc", content: "visit example gizmo" }, ctx);
    // A '/' in the query used to throw INVALID_URI via parseUri's '//' guard.
    const out = await api.run<{ results: Array<{ id: string }> }>(
      "context_search",
      { query: "http://example gizmo" },
      ctx,
    );
    expect(out.results.some((r) => r.id === "nodes/url-doc")).toBe(true);
  });

  it("context_publish bumps version + returns a checkpoint", async () => {
    const api = createEngineApi();
    // create auto-publishes at v1; publishing again bumps to v2.
    await api.run("context_create", { title: "Pub Me", content: "b" }, ctx);
    const out = await api.run<{ id: string; version: number; checkpoint: number }>(
      "context_publish",
      { id: "nodes/pub-me" },
      ctx,
    );
    expect(out.version).toBe(2);
    expect(out.checkpoint).toBeGreaterThanOrEqual(1);
  });

  it("context_delete removes a node; a later get is NOT_FOUND", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Doomed", content: "b" }, ctx);
    const out = await api.run<{ id: string; deleted: boolean }>(
      "context_delete",
      { id: "nodes/doomed" },
      ctx,
    );
    expect(out.deleted).toBe(true);
    await expect(api.run("context_get", { id: "nodes/doomed" }, ctx)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("context_versions returns the node's history", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Historic", content: "b" }, ctx);
    const out = await api.run<{ id: string; versions: Array<{ chain_hash: string }> }>(
      "context_versions",
      { id: "nodes/historic" },
      ctx,
    );
    expect(out.versions.length).toBeGreaterThanOrEqual(1);
    expect(out.versions[0].chain_hash).toMatch(/^sha256:/);
  });

  it("context_versions attaches change logs only when asked", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Logged", content: "first" }, ctx);
    await api.run(
      "context_update",
      { id: "nodes/logged", content: "second body" },
      ctx,
    );

    type Out = { versions: Array<{ version: number; keyframe: boolean; diff?: string }> };
    // Default stays lean — a history listing must not push patches at an agent.
    const lean = await api.run<Out>("context_versions", { id: "nodes/logged" }, ctx);
    expect(lean.versions.every((v) => v.diff === undefined)).toBe(true);

    const full = await api.run<Out>(
      "context_versions",
      { id: "nodes/logged", include_diff: true },
      ctx,
    );
    const patched = full.versions.filter((v) => !v.keyframe);
    expect(patched.length).toBeGreaterThan(0);
    // A real unified diff, same bytes the v{N}.diff file holds.
    expect(patched[0].diff).toContain("@@");
    // Keyframes are full snapshots, so they carry no patch.
    expect(full.versions.filter((v) => v.keyframe).every((v) => !v.diff)).toBe(true);
  });

  it("context_init opens the vault in one call: instructions, config and counts", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Alpha", content: "b", tags: ["#x"] }, ctx);
    await api.run("context_create", { title: "Beta", content: "b", type: "glossary" }, ctx);
    type Init = {
      context_md: string | null;
      vault_path: string;
      config: { name: string } | null;
      total: number;
      by_type: Record<string, number>;
      tags: string[];
      nodes?: Array<{ id: string }>;
    };
    const out = await api.run<Init>("context_init", {}, ctx);
    expect(out.total).toBeGreaterThanOrEqual(2);
    expect(out.by_type.document).toBeGreaterThanOrEqual(1);
    expect(out.by_type.glossary).toBeGreaterThanOrEqual(1);
    expect(out.tags).toContain("#x");
    expect(out.vault_path).toBe(dir);
    // The node list is the expensive part, so it is opt-in.
    expect(out.nodes).toBeUndefined();

    const withNodes = await api.run<Init>("context_init", { include_nodes: true }, ctx);
    expect(withNodes.nodes?.some((n) => n.id === "nodes/alpha")).toBe(true);
    expect((await api.run<Init>("context_init", { include_nodes: true, limit: 1 }, ctx)).nodes)
      .toHaveLength(1);
  });

  it("context_init counts retired nodes, which discovery drops by default", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Live One", content: "b" }, ctx);
    await api.run("context_create", { title: "Dead One", content: "b" }, ctx);
    await api.run("context_update", { id: "nodes/dead-one", status: "rejected" }, ctx);
    const out = await api.run<{ by_status: Record<string, number>; total: number }>(
      "context_init",
      {},
      ctx,
    );
    expect(out.by_status.rejected).toBe(1);
    expect(out.total).toBe(2);
  });

  it("context_reconstruct returns a past version's content", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Evolving", content: "original body" }, ctx);
    await api.run("context_update", { id: "nodes/evolving", content: "rewritten body" }, ctx);
    const out = await api.run<{ id: string; version: number; content: string }>(
      "context_reconstruct",
      { id: "nodes/evolving", version: 1 },
      ctx,
    );
    expect(out.version).toBe(1);
    expect(out.content).toContain("original body");
  });

  it("context_reconstruct honors its error contract (coded errors)", async () => {
    const api = createEngineApi();
    // A doc on disk with NO version history (never published) → reconstructVersion
    // throws a coded VERSION_NOT_FOUND, which the executor passes through.
    const node: ContextNode = {
      id: "nodes/nohist",
      filePath: "",
      rawContent: "",
      frontmatter: { title: "NoHist", type: "document", status: "draft" },
      body: "b",
    };
    await ctx.storage.writeDocument("nodes/nohist", serializeDocument(node));
    await expect(
      api.run("context_reconstruct", { id: "nodes/nohist", version: 1 }, ctx),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    // Bogus id → DOCUMENT_NOT_FOUND (as advertised), not an un-coded error.
    await expect(
      api.run("context_reconstruct", { id: "nodes/ghost", version: 1 }, ctx),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  });

  it("concurrent context_create for the same id — exactly one wins (no clobber)", async () => {
    const api = createEngineApi();
    const results = await Promise.allSettled([
      api.run("context_create", { title: "Racer", content: "first" }, ctx),
      api.run("context_create", { title: "Racer", content: "second" }, ctx),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
  });

  it("context_verify reports valid chains for a healthy vault", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Sound", content: "b" }, ctx);
    const out = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, ctx);
    expect(out.valid).toBe(true);
    expect(out.errors).toHaveLength(0);
  });

  it("context_init returns the vault CONTEXT.md", async () => {
    await ctx.storage.writeContextMd("# Operating instructions");
    const api = createEngineApi();
    const out = await api.run<{ context_md: string | null }>("context_init", {}, ctx);
    expect(out.context_md).toContain("Operating instructions");
  });

  it("context_packs lists packs (empty when none defined)", async () => {
    const api = createEngineApi();
    const out = await api.run<{ packs: unknown[] }>("context_packs", {}, ctx);
    expect(Array.isArray(out.packs)).toBe(true);
  });

  it("context_create with publish:false leaves the node a draft", async () => {
    const api = createEngineApi();
    const out = await api.run<{ id: string; version: number; status: string }>(
      "context_create",
      { title: "Needs Review", content: "body", publish: false },
      ctx,
    );
    expect(out.status).toBe("draft");
    const got = await api.run<{ frontmatter: { status?: string } }>(
      "context_get",
      { id: out.id },
      ctx,
    );
    expect(got.frontmatter.status).toBe("draft");
  });

  it("context_create honours an explicit id over the title slug", async () => {
    const api = createEngineApi();
    const out = await api.run<{ id: string; status: string }>(
      "context_create",
      { title: "Human Title", content: "body", id: "nodes/system/deterministic-id" },
      ctx,
    );
    expect(out.id).toBe("nodes/system/deterministic-id");
    expect(out.status).toBe("published");
  });

  it("context_create rejects an explicit id that escapes the vault", async () => {
    const api = createEngineApi();
    await expect(
      api.run("context_create", { title: "Escape", content: "b", id: "../../outside" }, ctx),
    ).rejects.toThrow(/path traversal/);
  });

  it("context_create builds a valid skill node from the skill fields", async () => {
    const api = createEngineApi();
    const out = await api.run<{ id: string }>(
      "context_create",
      {
        title: "Deploy Skill",
        content: "steps",
        type: "skill",
        trigger: "when asked to deploy",
        tools_required: ["bash"],
        output_format: "markdown",
      },
      ctx,
    );
    const got = await api.run<{ frontmatter: any }>("context_get", { id: out.id }, ctx);
    // A `skill` block, not loose top-level keys — validation requires it.
    expect(got.frontmatter.skill).toMatchObject({
      trigger: "when asked to deploy",
      tools_required: ["bash"],
      output_format: "markdown",
    });
  });

  it("context_import bulk-creates many nodes under ONE checkpoint", async () => {
    const api = createEngineApi();
    const documents = Array.from({ length: 6 }, (_, i) => ({
      title: `Imported ${i}`,
      content: `body ${i}`,
      tags: ["#bulk"],
    }));
    const out = await api.run<{
      published: Array<{ id: string; version: number }>;
      failed: unknown[];
      checkpoint: number | null;
    }>("context_import", { documents }, ctx);

    expect(out.published).toHaveLength(6);
    expect(out.failed).toHaveLength(0);
    expect(out.published.every((c) => c.version === 1)).toBe(true);
    expect(out.checkpoint).not.toBeNull();
    // Whole batch sealed one checkpoint, not one-per-doc.
    const history = await ctx.storage.readCheckpointHistory();
    expect(history?.checkpoints).toHaveLength(1);
    // Imported docs are published and retrievable.
    const got = await api.run<{ frontmatter: { status?: string } }>(
      "context_get",
      { id: "nodes/imported-0" },
      ctx,
    );
    expect(got.frontmatter.status).toBe("published");
  });

  it("context_import reports per-document failures without aborting the batch", async () => {
    const api = createEngineApi();
    const out = await api.run<{
      published: Array<{ id: string }>;
      failed: Array<{ title?: string; error: string }>;
    }>(
      "context_import",
      {
        documents: [
          { title: "Fine One", content: "b" },
          { title: "日本語のみ", content: "b" }, // no slug-able chars → fails
          { title: "Fine Two", content: "b" },
        ],
      },
      ctx,
    );
    expect(out.published).toHaveLength(2);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].title).toBe("日本語のみ");
  });

  it("context_import publishes ids already in the vault, preserving their ids", async () => {
    const api = createEngineApi();
    // Files dropped straight into the vault (folder import) — nested paths and
    // frontmatter of their own, never routed through buildDraftNode.
    const ids = ["nodes/team/handbook", "nodes/team/deep/onboarding"];
    for (const id of ids) {
      await ctx.storage.writeDocument(
        id,
        `---\ntitle: ${id}\ntype: document\nstatus: draft\n---\n\nbody\n`,
      );
    }

    const out = await api.run<{
      published: Array<{ id: string; version: number }>;
      failed: unknown[];
      checkpoint: number | null;
    }>("context_import", { ids }, ctx);

    expect(out.published.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(out.failed).toHaveLength(0);
    // ONE checkpoint for the batch, same as the documents[] path.
    const history = await ctx.storage.readCheckpointHistory();
    expect(history?.checkpoints).toHaveLength(1);
    const got = await api.run<{ frontmatter: { status?: string } }>(
      "context_get",
      { id: "nodes/team/deep/onboarding" },
      ctx,
    );
    expect(got.frontmatter.status).toBe("published");
  });

  it("context_import publishes documents[] and ids[] under ONE checkpoint", async () => {
    const api = createEngineApi();
    await ctx.storage.writeDocument(
      "nodes/existing-one",
      "---\ntitle: Existing One\ntype: document\nstatus: draft\n---\n\nbody\n",
    );
    const out = await api.run<{
      published: Array<{ id: string }>;
      failed: unknown[];
    }>(
      "context_import",
      { documents: [{ title: "Fresh One", content: "b" }], ids: ["nodes/existing-one"] },
      ctx,
    );
    expect(out.published.map((p) => p.id).sort()).toEqual([
      "nodes/existing-one",
      "nodes/fresh-one",
    ]);
    const history = await ctx.storage.readCheckpointHistory();
    expect(history?.checkpoints).toHaveLength(1);
  });

  it("context_import reports progress through the context sink", async () => {
    const api = createEngineApi();
    const ticks: Array<[number, number]> = [];
    await api.run(
      "context_import",
      { documents: Array.from({ length: 4 }, (_, i) => ({ title: `Tick ${i}`, content: "b" })) },
      { ...ctx, onProgress: (done, total) => ticks.push([done, total]) },
    );
    expect(ticks).toHaveLength(4);
    expect(ticks.map(([done]) => done)).toEqual([1, 2, 3, 4]);
    expect(ticks.every(([, total]) => total === 4)).toBe(true);
  });

  it("context_import rejects a call with neither documents nor ids", async () => {
    const api = createEngineApi();
    await expect(api.run("context_import", {}, ctx)).rejects.toThrow(/documents\[\] or ids\[\]/);
  });

  it("normalizes tags to #-prefixed form on create (S7)", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Tagged", content: "b", tags: ["api", "ml"] }, ctx);
    const got = await api.run<{ frontmatter: { tags?: string[] } }>(
      "context_get",
      { id: "nodes/tagged" },
      ctx,
    );
    expect(got.frontmatter.tags).toEqual(["#api", "#ml"]);
  });

  it("rejects an invalid source node before writing (S5 validation)", async () => {
    const api = createEngineApi();
    // type:"source" requires a source block (spec §13.1 rule 9) — none supplied.
    await expect(
      api.run("context_create", { title: "Bad Source", content: "b", type: "source" }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("resolves legacy aliases through the runtime", async () => {
    const api = createEngineApi();
    expect(api.getOperation("read_document")?.name).toBe("context_get");
    expect(api.getOperation("create_document")?.name).toBe("context_create");
  });

  it("rejects invalid input with VALIDATION_FAILED before executing", async () => {
    const api = createEngineApi();
    await expect(api.run("context_create", { title: "" }, ctx)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(api.run("context_get", {}, ctx)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("throws UNKNOWN_OPERATION for an unregistered name", async () => {
    const api = createEngineApi();
    await expect(api.run("context_nonsense", {}, ctx)).rejects.toMatchObject({
      code: "UNKNOWN_OPERATION",
    });
  });
});

describe("EngineExtension — authorization + capability registration", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an authorize hook can deny an operation (commercial-governance seam)", async () => {
    const stewardship: EngineExtension = {
      name: "test-stewardship",
      authorize({ operation }) {
        if (operation.name === "context_create") {
          throw new UnauthorizedActionError("tester@example.com", "context_create");
        }
      },
    };
    const api = createEngineApi({ extensions: [stewardship] });
    await expect(
      api.run("context_create", { title: "Blocked", content: "x" }, ctx),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    // A non-denied op still runs.
    const listed = await api.run<{ documents: unknown[] }>("context_list", {}, ctx);
    expect(Array.isArray(listed.documents)).toBe(true);
  });

  it("onResult observes successful executions", async () => {
    const seen: string[] = [];
    const audit: EngineExtension = {
      name: "test-audit",
      onResult({ operation }) {
        seen.push(operation.name);
      },
    };
    const api = createEngineApi({ extensions: [audit] });
    await api.run("context_create", { title: "Observed", content: "x" }, ctx);
    expect(seen).toContain("context_create");
  });

  it("an extension registers a new operation + executor and advertises its namespace", async () => {
    const pingOp: OperationDescriptor = {
      name: "context_ping",
      namespace: "workflow",
      description: "test op",
      input: z.object({ msg: z.string() }),
      output: z.object({ echo: z.string() }),
      errors: [],
    };
    const ext: EngineExtension = {
      name: "test-workflow",
      operations: [pingOp],
      executors: { context_ping: (_ctx, input: any) => ({ echo: input.msg }) },
    };
    const api = createEngineApi({ extensions: [ext] });
    expect(api.namespaces.workflow.implemented).toBe(true);
    expect(api.namespaces.core.implemented).toBe(true);
    const out = await api.run<{ echo: string }>("context_ping", { msg: "hi" }, ctx);
    expect(out.echo).toBe("hi");
  });

  it("throws on an operation-name collision from an extension", () => {
    const dup: OperationDescriptor = {
      name: "context_get", // collides with a core op
      namespace: "core",
      description: "dup",
      input: z.object({}),
      output: z.object({}),
      errors: [],
    };
    expect(() =>
      createEngineApi({ extensions: [{ name: "bad", operations: [dup] }] }),
    ).toThrow(/Duplicate operation/);
  });
});

describe("core executors — review-fix regressions", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("context_update on a rejected doc fails WITHOUT mutating the file", async () => {
    const rejected: ContextNode = {
      id: "nodes/gone",
      filePath: "",
      rawContent: "",
      frontmatter: { title: "Gone", status: "rejected" },
      body: "original body",
    };
    await ctx.storage.writeDocument("nodes/gone", serializeDocument(rejected));

    const api = createEngineApi();
    await expect(
      api.run("context_update", { id: "nodes/gone", append: "APPENDED_MARKER" }, ctx),
    ).rejects.toMatchObject({ code: "REJECTED_DOCUMENT" });

    // File must be untouched — no append, no version bump.
    const afterFile = await ctx.storage.readDocument("nodes/gone");
    expect(afterFile.body).toContain("original body");
    expect(afterFile.body).not.toContain("APPENDED_MARKER");
  });

  it("context_create rejects a title with no slug-able characters", async () => {
    const api = createEngineApi();
    await expect(
      api.run("context_create", { title: "日本語のみ", content: "b" }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("context_update replaces tags and de-duplicates them", async () => {
    const api = createEngineApi();
    await api.run(
      "context_create",
      { title: "Dedupe", content: "b", tags: ["#api", "#legacy"] },
      ctx,
    );
    await api.run("context_update", { id: "nodes/dedupe", tags: ["api", "#api", "ml"] }, ctx);
    const got = await api.run<{ frontmatter: { tags?: string[] } }>(
      "context_get",
      { id: "nodes/dedupe" },
      ctx,
    );
    // #legacy is gone: the list replaces rather than merges, matching the CLI,
    // mcp-server and context_create.
    expect(got.frontmatter.tags).toEqual(["#api", "#ml"]);
  });
});

// ─── context_update — publish resolution ─────────────────────────────────────
//
// The CLI and mcp-server each hand-rolled "a lifecycle status change is
// metadata, not a release". The op owns that rule now, so it is pinned here.

describe("context_update — when it publishes", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const api = createEngineApi();
  const historyLength = async (id: string) =>
    (await ctx.storage.readHistory(id))?.versions.length ?? 0;

  it("publishes a content edit", async () => {
    await api.run("context_create", { title: "Live", content: "one" }, ctx);
    const before = await historyLength("nodes/live");
    const res = await api.run<{ status: string; checkpoint: number | null }>(
      "context_update",
      { id: "nodes/live", content: "two" },
      ctx,
    );
    expect(res.status).toBe("published");
    expect(res.checkpoint).not.toBeNull();
    expect(await historyLength("nodes/live")).toBe(before + 1);
  });

  it.each(["draft", "pending_review", "approved", "rejected"])(
    "treats a %s transition as metadata — no version cut",
    async (status) => {
      await api.run("context_create", { title: "Cycle", content: "one" }, ctx);
      const before = await historyLength("nodes/cycle");
      const res = await api.run<{ status: string; checkpoint: number | null }>(
        "context_update",
        { id: "nodes/cycle", status },
        ctx,
      );
      expect(res.status).toBe(status);
      expect(res.checkpoint).toBeNull();
      expect(await historyLength("nodes/cycle")).toBe(before);
    },
  );

  it("honours an explicit publish:false over the derived default", async () => {
    await api.run("context_create", { title: "Held", content: "one" }, ctx);
    const before = await historyLength("nodes/held");
    const res = await api.run<{ version: number; checkpoint: number | null }>(
      "context_update",
      { id: "nodes/held", content: "two", publish: false, version: 7 },
      ctx,
    );
    // A governed caller assigns its own version for a revision awaiting review.
    expect(res.version).toBe(7);
    expect(res.checkpoint).toBeNull();
    expect(await historyLength("nodes/held")).toBe(before);
    const got = await api.run<{ frontmatter: { checksum?: string }; body: string }>(
      "context_get",
      { id: "nodes/held" },
      ctx,
    );
    expect(got.body).toContain("two");
    // Stale published-state checksum dropped, or the next verified read reports
    // this write as external drift.
    expect(got.frontmatter.checksum).toBeUndefined();
  });

  it("revives a rejected doc when the caller names a new status", async () => {
    await api.run("context_create", { title: "Retired", content: "one" }, ctx);
    await api.run("context_update", { id: "nodes/retired", status: "rejected" }, ctx);
    // Content-only edit stays refused …
    await expect(
      api.run("context_update", { id: "nodes/retired", content: "sneaky" }, ctx),
    ).rejects.toMatchObject({ code: "REJECTED_DOCUMENT" });
    // … but declaring a status revives it.
    const res = await api.run<{ status: string }>(
      "context_update",
      { id: "nodes/retired", status: "draft", content: "revived" },
      ctx,
    );
    expect(res.status).toBe("draft");
    const got = await api.run<{ body: string }>("context_get", { id: "nodes/retired" }, ctx);
    expect(got.body).toContain("revived");
  });
});

// ─── context_list — filters ──────────────────────────────────────────────────
//
// The CLI, mcp-server and Community each grew a private copy of this filter and
// each got a different subset of the rules right. These pin the shared one.

describe("context_list — filters", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const api = createEngineApi();
  const ids = (r: { documents: Array<{ id: string }> }) => r.documents.map((d) => d.id).sort();
  const list = (input: object = {}) =>
    api.run<{ documents: Array<{ id: string }> }>("context_list", input, ctx);

  /** A document with NO `type:` field — the common case, and the one a literal
   *  type comparison used to skip. */
  const writeUntyped = async (id: string, status: string, tags = "") =>
    ctx.storage.writeDocument(
      id,
      `---\ntitle: ${id}\nstatus: ${status}\n${tags}---\n\nbody\n`,
    );

  it("matches untyped documents against type:document", async () => {
    await writeUntyped("nodes/plain", "published");
    await api.run("context_create", { title: "A Skill", content: "b", type: "skill", trigger: "when asked" }, ctx);
    expect(await list({ type: "document" }).then(ids)).toEqual(["nodes/plain"]);
  });

  it("accepts several types at once", async () => {
    await writeUntyped("nodes/plain", "published");
    await api.run("context_create", { title: "A Skill", content: "b", type: "skill", trigger: "when asked" }, ctx);
    await api.run("context_create", { title: "An Agent", content: "b", type: "agent" }, ctx);
    expect(await list({ type: ["skill", "agent"] }).then(ids)).toEqual([
      "nodes/a-skill",
      "nodes/an-agent",
    ]);
  });

  it("finds retired documents on status:rejected, and hides them otherwise", async () => {
    await writeUntyped("nodes/live", "published");
    await writeUntyped("nodes/dead", "rejected");
    // Discovery drops retired docs, so this filter used to match nothing at all.
    expect(await list({ status: "rejected" }).then(ids)).toEqual(["nodes/dead"]);
    expect(await list().then(ids)).toEqual(["nodes/live"]);
  });

  it("normalizes status aliases", async () => {
    await writeUntyped("nodes/live", "published");
    expect(await list({ status: "active" }).then(ids)).toEqual(["nodes/live"]);
  });

  it("matches a tag with or without its # and regardless of case", async () => {
    await writeUntyped("nodes/tagged", "published", "tags:\n  - '#API'\n");
    await writeUntyped("nodes/untagged", "published");
    for (const tag of ["#API", "API", "api", "#api"]) {
      expect(await list({ tag }).then(ids)).toEqual(["nodes/tagged"]);
    }
  });

  it("applies limit last", async () => {
    await writeUntyped("nodes/a", "published");
    await writeUntyped("nodes/b", "published");
    await writeUntyped("nodes/c", "rejected");
    // Retired doc is excluded before the limit counts, not after.
    expect((await list({ limit: 2 })).documents).toHaveLength(2);
  });

  it("include_retired keeps retired nodes with no status filter", async () => {
    await writeUntyped("nodes/live", "published");
    await writeUntyped("nodes/dead", "rejected");
    // Governed surfaces list a rejected node as one its stewards still act on.
    expect(await list({ include_retired: true }).then(ids)).toEqual([
      "nodes/dead",
      "nodes/live",
    ]);
  });

  it("full returns frontmatter and body so callers need not re-read the files", async () => {
    await ctx.storage.writeDocument(
      "nodes/rich",
      `---\ntitle: Rich\nstatus: published\nversion: 4\nauthor: someone@example.com\ncreated_at: '2024-01-01T00:00:00.000Z'\n---\n\nthe body\n`,
    );
    const summary = (await list()).documents[0] as Record<string, unknown>;
    expect(summary.frontmatter).toBeUndefined();
    expect(summary.body).toBeUndefined();

    const full = (await list({ full: true })).documents[0] as unknown as {
      body: string;
      frontmatter: { version?: number; author?: string; created_at?: string };
    };
    expect(full.body).toContain("the body");
    // The fields a summary drops are exactly why `full` exists.
    expect(full.frontmatter.version).toBe(4);
    expect(full.frontmatter.author).toBe("someone@example.com");
    expect(full.frontmatter.created_at).toBeTruthy();
  });
});

// ─── context_get — what each surface needs beyond {id, frontmatter, body} ────

describe("context_get — raw, rejected, selector", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const api = createEngineApi();

  it("include_raw returns the exact stored bytes, frontmatter block and all", async () => {
    await api.run("context_create", { title: "Raw Doc", content: "the body" }, ctx);
    const plain = await api.run<{ raw?: string }>("context_get", { id: "nodes/raw-doc" }, ctx);
    expect(plain.raw).toBeUndefined();

    const withRaw = await api.run<{ raw: string; body: string }>(
      "context_get",
      { id: "nodes/raw-doc", include_raw: true },
      ctx,
    );
    // `body` is the parsed body; `raw` still carries the frontmatter block, so
    // a caller can re-serve the file verbatim.
    expect(withRaw.raw).toContain("---");
    expect(withRaw.raw).toContain("title: Raw Doc");
    expect(withRaw.raw).toContain("the body");
    expect(withRaw.body).not.toContain("title: Raw Doc");
  });

  it("refuses a rejected node, unless the caller allows it", async () => {
    await api.run("context_create", { title: "Retired Doc", content: "body" }, ctx);
    await api.run("context_update", { id: "nodes/retired-doc", status: "rejected" }, ctx);

    await expect(api.run("context_get", { id: "nodes/retired-doc" }, ctx)).rejects.toMatchObject({
      code: "REJECTED_DOCUMENT",
    });
    // Reading one is not republishing it — governed surfaces show retired docs.
    const allowed = await api.run<{ frontmatter: { status?: string } }>(
      "context_get",
      { id: "nodes/retired-doc", allow_rejected: true },
      ctx,
    );
    expect(allowed.frontmatter.status).toBe("rejected");
  });

  it("still demands a selector now that the schema no longer refines one", async () => {
    // The `.refine` came off so MCP can register these ops at all; the same
    // error has to survive as a runtime check.
    await expect(api.run("context_get", {}, ctx)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(api.run("context_versions", {}, ctx)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});
describe("context_nests — registry-scoped operation", () => {
  let tmp: string;
  let savedConfigDir: string | undefined;

  /** A directory that looks like a vault, optionally with its own name/description. */
  function makeVault(dir: string, name?: string, description?: string): string {
    mkdirSync(join(dir, ".context"), { recursive: true });
    writeFileSync(
      join(dir, ".context", "config.yaml"),
      `version: 1\n${name ? `name: "${name}"\n` : ""}${description ? `description: "${description}"\n` : ""}`,
    );
    return dir;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-api-nests-"));
    savedConfigDir = process.env.CONTEXTNEST_CONFIG_DIR;
    process.env.CONTEXTNEST_CONFIG_DIR = join(tmp, "cfg");
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CONTEXTNEST_CONFIG_DIR;
    else process.env.CONTEXTNEST_CONFIG_DIR = savedConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists every registered nest and resolves description precedence", async () => {
    // Registry description wins; config `description` beats config `name`;
    // neither present → undefined.
    addVault("labelled", makeVault(join(tmp, "a"), "A", "config desc"), {
      description: "registry desc",
    });
    addVault("described", makeVault(join(tmp, "b"), "B", "config desc"));
    addVault("bare", makeVault(join(tmp, "c"), "C"), {});
    addVault("unlabelled", makeVault(join(tmp, "d")), {});
    // Registered, then deleted from disk — the only way to reach `exists: false`,
    // since addVault rejects a path that is not already a vault.
    addVault("gone", makeVault(join(tmp, "e"), "E"), {});
    rmSync(join(tmp, "e"), { recursive: true, force: true });
    setDefaultVault("described");

    // Registry-scoped: the executor ignores ctx, so an empty one is enough.
    const result = await createEngineApi().run(
      "context_nests",
      {},
      {} as unknown as OperationContext,
    );

    // The op's own output schema is the contract — validate against it.
    const parsed = OPERATIONS.context_nests.output.parse(result) as {
      nests: { alias: string; description?: string; isDefault: boolean; exists: boolean }[];
    };
    const byAlias = Object.fromEntries(parsed.nests.map((n) => [n.alias, n]));

    expect(Object.keys(byAlias).sort()).toEqual([
      "bare",
      "described",
      "gone",
      "labelled",
      "unlabelled",
    ]);
    expect(byAlias.labelled.description).toBe("registry desc");
    expect(byAlias.described.description).toBe("config desc");
    expect(byAlias.bare.description).toBe("C"); // falls back to config `name`
    expect(byAlias.unlabelled.description).toBeUndefined();
    expect(byAlias.described.isDefault).toBe(true);
    expect(byAlias.labelled.isDefault).toBe(false);
    expect(byAlias.bare.exists).toBe(true);
    expect(byAlias.gone.exists).toBe(false);
  });
});

describe("context_reconstruct — asking for a version that isn't there", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const api = createEngineApi();

  it("refuses a version the history does not contain", async () => {
    await api.run("context_create", { title: "Only V1", content: "first" }, ctx);
    // Reconstruction starts at the nearest keyframe at or before the target and
    // replays diffs forward, so v99 used to land on v1's keyframe, find nothing
    // to replay, and return v1's content AS v99.
    await expect(
      api.run("context_reconstruct", { id: "nodes/only-v1", version: 99 }, ctx),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
  });

  it("still reconstructs a version that does exist", async () => {
    await api.run("context_create", { title: "Two Versions", content: "first" }, ctx);
    await api.run("context_update", { id: "nodes/two-versions", content: "second" }, ctx);
    const v2 = await api.run<{ content: string }>(
      "context_reconstruct",
      { id: "nodes/two-versions", version: 2 },
      ctx,
    );
    expect(v2.content).toContain("second");
    const v1 = await api.run<{ content: string }>(
      "context_reconstruct",
      { id: "nodes/two-versions", version: 1 },
      ctx,
    );
    expect(v1.content).toContain("first");
  });
});

// ─── Review follow-ups: rejected handling and id tolerance ───────────────────

describe("a rejected status never publishes, and never strands a file", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const api = createEngineApi();

  it("creates a rejected node as a draft instead of writing then crashing", async () => {
    // Publish refuses a rejected doc. This used to write the file, throw from
    // publish, and leave an orphan with no version — so the caller's retry hit
    // DOCUMENT_ALREADY_EXISTS for a create it believed had failed.
    const res = await api.run<{ id: string; status: string; checkpoint: number | null }>(
      "context_create",
      { title: "Born Rejected", content: "x", status: "rejected" },
      ctx,
    );
    expect(res.status).toBe("rejected");
    expect(res.checkpoint).toBeNull();
    const got = await api.run<{ frontmatter: { version?: number } }>(
      "context_get",
      { id: res.id, allow_rejected: true },
      ctx,
    );
    expect(got.frontmatter.version).toBe(1);
  });

  it("ignores an explicit publish:true when the edit lands on rejected", async () => {
    await api.run("context_create", { title: "Going Away", content: "original" }, ctx);
    const res = await api.run<{ checkpoint: number | null }>(
      "context_update",
      { id: "nodes/going-away", status: "rejected", publish: true },
      ctx,
    );
    expect(res.checkpoint).toBeNull();
  });

  it("refuses an edit that re-asserts rejected, rather than rewriting the body", async () => {
    await api.run("context_create", { title: "Stay Put", content: "original" }, ctx);
    await api.run("context_update", { id: "nodes/stay-put", status: "rejected" }, ctx);
    // A client echoing the current status back alongside an edit used to slip
    // past the guard and mutate a document that stayed rejected.
    await expect(
      api.run(
        "context_update",
        { id: "nodes/stay-put", status: "rejected", content: "MUTATED" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "REJECTED_DOCUMENT" });
    const got = await api.run<{ body: string }>(
      "context_get",
      { id: "nodes/stay-put", allow_rejected: true },
      ctx,
    );
    expect(got.body).toContain("original");
    expect(got.body).not.toContain("MUTATED");
  });
});

describe("id and title tolerance", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const api = createEngineApi();

  it("accepts an id built from a file path (.md suffix, leading slash)", async () => {
    await api.run("context_create", { title: "Path Doc", content: "body" }, ctx);
    // Storage appends `.md` itself, so an un-stripped suffix resolved to
    // `<id>.md.md` and 404'd. Callers build ids from file paths all the time.
    for (const id of ["nodes/path-doc", "nodes/path-doc.md", "/nodes/path-doc"]) {
      const got = await api.run<{ id: string }>("context_get", { id }, ctx);
      expect(got.id).toBe("nodes/path-doc");
    }
  });

  it("still does NOT re-root a bare id, which a flat-layout vault depends on", async () => {
    // The contract is "exactly as stored". Re-rooting `flat-doc` to
    // `nodes/flat-doc` is what broke every read in an imported vault.
    await ctx.storage.writeDocument(
      "flat-doc",
      `---\ntitle: Flat Doc\nstatus: published\n---\n\nbody\n`,
    );
    const got = await api.run<{ id: string }>("context_get", { id: "flat-doc" }, ctx);
    expect(got.id).toBe("flat-doc");
  });

  it("finds a retired document by title, not just by id", async () => {
    // A custom id means the slug guess cannot rescue this: title lookup has to
    // actually see the retired doc.
    await api.run(
      "context_create",
      { id: "nodes/custom/slot-7", title: "Quarterly Plan", content: "body" },
      ctx,
    );
    await api.run("context_update", { id: "nodes/custom/slot-7", status: "rejected" }, ctx);
    const got = await api.run<{ id: string }>(
      "context_get",
      { title: "Quarterly Plan", allow_rejected: true },
      ctx,
    );
    expect(got.id).toBe("nodes/custom/slot-7");
  });
});
