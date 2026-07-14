import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
  type OperationContext,
  type EngineExtension,
  type OperationDescriptor,
} from "../api/index.js";

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

  it("update by title (not id) resolves the real doc (regression: C2)", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "My Cool Title", content: "orig" }, ctx);
    const updated = await api.run<{ id: string; version: number }>(
      "context_update",
      { title: "My Cool Title", append: "more" },
      ctx,
    );
    expect(updated.id).toBe("nodes/my-cool-title");
    const got = await api.run<{ body: string }>("context_get", { title: "My Cool Title" }, ctx);
    expect(got.body).toContain("more");
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

  it("context_update de-duplicates merged tags", async () => {
    const api = createEngineApi();
    await api.run("context_create", { title: "Dedupe", content: "b", tags: ["#api"] }, ctx);
    await api.run("context_update", { id: "nodes/dedupe", tags: ["api", "#api", "ml"] }, ctx);
    const got = await api.run<{ frontmatter: { tags?: string[] } }>(
      "context_get",
      { id: "nodes/dedupe" },
      ctx,
    );
    expect(got.frontmatter.tags).toEqual(["#api", "#ml"]);
  });
});
