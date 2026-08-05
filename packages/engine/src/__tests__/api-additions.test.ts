/**
 * Catalog additions made for the remote-nest work: trace_count on
 * context_query, include_raw/raw on context_get, explicit id on
 * context_create, description in node summaries, and the INTERNAL error code.
 * Each addition is what keeps a remote `ctx` invocation's output
 * shape-identical to the local command, so these pin both the schema and the
 * executor behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { ContextNestError } from "../errors.js";
import {
  createEngineApi,
  getOperation,
  inputJsonSchema,
  ERROR_CODES,
  type OperationContext,
} from "../api/index.js";

async function makeContext(): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-api-additions-"));
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

describe("catalog additions for remote nests", () => {
  let ctx: OperationContext;
  let dir: string;
  const api = createEngineApi();

  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── context_create explicit id ────────────────────────────────────────────

  it("context_create honors an explicit id over folder + slugified title", async () => {
    const created = await api.run<{ id: string }>(
      "context_create",
      { id: "nodes/custom-path", title: "A Totally Different Title", content: "body" },
      ctx,
    );
    expect(created.id).toBe("nodes/custom-path");
    // The file lands at the explicit path, not at the slug of the title.
    await expect(readFile(join(dir, "nodes", "custom-path.md"), "utf-8")).resolves.toContain(
      "A Totally Different Title",
    );
  });

  it("context_create normalizes a bare explicit id into nodes/", async () => {
    const created = await api.run<{ id: string }>(
      "context_create",
      { id: "bare-slug", title: "Bare", content: "b" },
      ctx,
    );
    expect(created.id).toBe("nodes/bare-slug");
  });

  it("context_create with explicit id still refuses to clobber an existing doc", async () => {
    await api.run("context_create", { id: "nodes/dup", title: "One", content: "1" }, ctx);
    const err = await api
      .run("context_create", { id: "nodes/dup", title: "Two", content: "2" }, ctx)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ContextNestError);
    // The original bytes are intact.
    await expect(readFile(join(dir, "nodes", "dup.md"), "utf-8")).resolves.toContain("One");
  });

  it("context_create without id keeps the folder + title derivation", async () => {
    const created = await api.run<{ id: string }>(
      "context_create",
      { title: "Derived Doc", content: "b", folder: "gtm/deals" },
      ctx,
    );
    expect(created.id).toBe("nodes/gtm/deals/derived-doc");
  });

  it("the context_create input schema advertises the id property", () => {
    const schema = inputJsonSchema(getOperation("context_create")!) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toContain("id");
  });

  // ── context_get include_raw ───────────────────────────────────────────────

  it("context_get returns the exact on-disk bytes when include_raw is set", async () => {
    const created = await api.run<{ id: string }>(
      "context_create",
      { title: "Raw Doc", content: "raw body here" },
      ctx,
    );
    const got = await api.run<{ raw?: string; body: string }>(
      "context_get",
      { id: created.id, include_raw: true },
      ctx,
    );
    const onDisk = await readFile(join(dir, `${created.id}.md`), "utf-8");
    expect(got.raw).toBe(onDisk);
  });

  it("context_get omits raw when include_raw is not set", async () => {
    const created = await api.run<{ id: string }>(
      "context_create",
      { title: "No Raw", content: "b" },
      ctx,
    );
    const got = await api.run<Record<string, unknown>>("context_get", { id: created.id }, ctx);
    expect("raw" in got).toBe(false);
  });

  // ── context_query trace_count ─────────────────────────────────────────────

  it("context_query reports trace_count as a number", async () => {
    await api.run("context_create", { title: "Traced", content: "b", tags: ["#traced"] }, ctx);
    const out = await api.run<{ trace_count?: number }>(
      "context_query",
      { query: "#traced" },
      ctx,
    );
    expect(typeof out.trace_count).toBe("number");
  });

  // ── description in summaries ──────────────────────────────────────────────

  it("summaries carry frontmatter.description when present, omit it when absent", async () => {
    // context_create has no description param — write one via raw storage.
    await ctx.storage.writeDocument(
      "nodes/with-desc",
      [
        "---",
        "title: With Description",
        "description: A short summary",
        "type: document",
        "status: published",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    await api.run("context_create", { title: "Without Desc", content: "b" }, ctx);
    await ctx.storage.regenerateIndex();

    const listed = await api.run<{
      documents: Array<{ id: string; description?: string }>;
    }>("context_list", {}, ctx);
    const withDesc = listed.documents.find((d) => d.id === "nodes/with-desc")!;
    const withoutDesc = listed.documents.find((d) => d.id === "nodes/without-desc")!;
    expect(withDesc.description).toBe("A short summary");
    expect("description" in withoutDesc).toBe(false);
  });

  it("context_search results include description (the ctx search --json contract)", async () => {
    await ctx.storage.writeDocument(
      "nodes/searchable",
      [
        "---",
        "title: Searchable Doc",
        "description: Findable by search",
        "type: document",
        "status: published",
        "---",
        "",
        "unique-search-term body",
      ].join("\n"),
    );
    await ctx.storage.regenerateIndex();
    const out = await api.run<{ results: Array<{ description?: string }> }>(
      "context_search",
      { query: "unique-search-term" },
      ctx,
    );
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results[0].description).toBe("Findable by search");
  });

  // ── error model ───────────────────────────────────────────────────────────

  it("ERROR_CODES includes the INTERNAL catch-all", () => {
    expect(ERROR_CODES).toContain("INTERNAL");
  });

  it("output schemas accept the new optional fields (round-trip safety)", async () => {
    const query = getOperation("context_query")!;
    expect(
      query.output.safeParse({
        documents: [],
        traversal: { mode: "graph", hops_used: 0, nodes_traversed: 0 },
        trace_count: 5,
      }).success,
    ).toBe(true);

    const get = getOperation("context_get")!;
    expect(
      get.output.safeParse({
        id: "nodes/x",
        frontmatter: { title: "X" },
        body: "b",
        raw: "---\ntitle: X\n---\nb",
      }).success,
    ).toBe(true);
  });
});
