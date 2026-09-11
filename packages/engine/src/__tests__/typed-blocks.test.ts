/**
 * Typed frontmatter blocks (§13 rules 9/17, §1.10 rules 18/19).
 *
 * Two layers, deliberately:
 *  - the pure reconciliation, so a failure names the rule rather than the wiring;
 *  - the catalog round-trip, because the bug this fixes was that `type: source`
 *    nodes could be written but never updated — only an end-to-end create →
 *    update → re-type sequence proves that is gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { applyTypedBlocks } from "../typed-blocks.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import type { Frontmatter, SourceMeta } from "../types.js";

const SOURCE: SourceMeta = { transport: "mcp", server: "harvest", tools: ["list_projects"] };

function fm(extra: Partial<Frontmatter> = {}): Frontmatter {
  return { title: "Test", type: "document", status: "draft", version: 1, ...extra };
}

describe("applyTypedBlocks", () => {
  it("refuses a source node with no block (rule 9), naming the shape to pass", () => {
    expect(() => applyTypedBlocks(fm(), { type: "source" })).toThrow(/rule 9[\s\S]*transport/);
  });

  it("accepts a supplied block and keeps an existing one", () => {
    const created = fm();
    applyTypedBlocks(created, { type: "source", source: SOURCE });
    expect(created.source).toEqual(SOURCE);

    const existing = fm({ type: "source", source: SOURCE });
    applyTypedBlocks(existing, { type: "source" });
    expect(existing.source).toEqual(SOURCE);
  });

  it("replaces an existing source block wholesale", () => {
    const frontmatter = fm({ type: "source", source: SOURCE });
    const next: SourceMeta = { transport: "rest", tools: ["get_estimate"], cache_ttl: 300 };
    applyTypedBlocks(frontmatter, { type: "source", source: next });
    expect(frontmatter.source).toEqual(next);
  });

  it("refuses a source block aimed at a non-source type (rule 17)", () => {
    expect(() => applyTypedBlocks(fm(), { type: "document", source: SOURCE })).toThrow(/rule 17/);
  });

  it("drops the block when re-typing away from source (rule 17)", () => {
    const frontmatter = fm({ type: "source", source: SOURCE });
    applyTypedBlocks(frontmatter, { type: "document" });
    expect(frontmatter.source).toBeUndefined();
  });

  it("requires a trigger for a skill node that has none (rule 18)", () => {
    expect(() => applyTypedBlocks(fm(), { type: "skill" })).toThrow(/rule 18/);
  });

  it("takes a create-time default trigger but preserves untouched fields on update", () => {
    const created = fm();
    applyTypedBlocks(created, { type: "skill", defaultTrigger: "when asked to test" });
    expect(created.skill).toEqual({ trigger: "when asked to test" });

    const existing = fm({
      type: "skill",
      skill: { trigger: "old", tools_required: ["a"], output_format: "json", guard_rails: ["no"] },
    });
    applyTypedBlocks(existing, { type: "skill", trigger: "new" });
    expect(existing.skill).toEqual({
      trigger: "new",
      tools_required: ["a"],
      output_format: "json",
      guard_rails: ["no"],
    });
  });

  it("refuses skill parameters aimed at a non-skill type (rule 19)", () => {
    expect(() => applyTypedBlocks(fm(), { type: "document", trigger: "whenever" })).toThrow(/rule 19/);
  });

  it("swaps blocks when re-typing straight from skill to source", () => {
    const frontmatter = fm({ type: "skill", skill: { trigger: "t" } });
    applyTypedBlocks(frontmatter, { type: "source", source: SOURCE });
    expect(frontmatter.skill).toBeUndefined();
    expect(frontmatter.source).toEqual(SOURCE);
  });
});

describe("source nodes round-trip through context_create / context_update", () => {
  const api = createEngineApi();
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-typed-blocks-"));
    const storage = new NestStorage(dir);
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function createSource(extra: Record<string, unknown> = {}) {
    return api.run<{ id: string }>(
      "context_create",
      { id: "nodes/src", title: "Src", content: "body", type: "source", source: SOURCE, ...extra },
      ctx,
    );
  }

  it("creates a source node carrying its block", async () => {
    const { id } = await createSource();
    const doc = await ctx.storage.readDocument(id);
    expect(doc.frontmatter.type).toBe("source");
    expect(doc.frontmatter.source).toEqual(SOURCE);
  });

  it("refuses a source node with no block, and writes nothing", async () => {
    await expect(
      api.run("context_create", { id: "nodes/src", title: "Src", content: "b", type: "source" }, ctx),
    ).rejects.toThrow(/rule 9/);
    await expect(ctx.storage.readDocument("nodes/src")).rejects.toThrow();
  });

  it("updates the source block on an existing source node", async () => {
    await createSource();
    await api.run(
      "context_update",
      { id: "nodes/src", source: { transport: "rest", server: "bigearnie", tools: ["get_estimate"] } },
      ctx,
    );
    const doc = await ctx.storage.readDocument("nodes/src");
    expect(doc.frontmatter.source).toEqual({
      transport: "rest",
      server: "bigearnie",
      tools: ["get_estimate"],
    });
  });

  it("updates a source node's other fields without losing its block", async () => {
    await createSource();
    await api.run("context_update", { id: "nodes/src", title: "Renamed" }, ctx);
    const doc = await ctx.storage.readDocument("nodes/src");
    expect(doc.frontmatter.title).toBe("Renamed");
    expect(doc.frontmatter.source).toEqual(SOURCE);
  });

  it("still rejects an empty tools list (rule 11)", async () => {
    await expect(
      api.run(
        "context_create",
        { id: "nodes/src", title: "Src", content: "b", type: "source", source: { transport: "mcp", tools: [] } },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("re-types document → source and source → document in one call each", async () => {
    await api.run("context_create", { id: "nodes/plain", title: "Plain", content: "b" }, ctx);

    await api.run("context_update", { id: "nodes/plain", type: "source", source: SOURCE }, ctx);
    let doc = await ctx.storage.readDocument("nodes/plain");
    expect(doc.frontmatter).toMatchObject({ type: "source", source: SOURCE });

    await api.run("context_update", { id: "nodes/plain", type: "document" }, ctx);
    doc = await ctx.storage.readDocument("nodes/plain");
    expect(doc.frontmatter.type).toBe("document");
    expect(doc.frontmatter.source).toBeUndefined();
  });

  it("refuses a source block on a node that stays type: document (rule 17)", async () => {
    await api.run("context_create", { id: "nodes/plain", title: "Plain", content: "b" }, ctx);
    await expect(
      api.run("context_update", { id: "nodes/plain", source: SOURCE }, ctx),
    ).rejects.toThrow(/rule 17/);
  });

  it("repairs a hand-seeded source node that has no block", async () => {
    // Exactly the state the bug produced: type: source, no source block. Written
    // straight to disk because the API can no longer produce one.
    await ctx.storage.writeDocument(
      "nodes/broken",
      ["---", "title: Broken", "type: source", "status: draft", "version: 1", "---", "", "body", ""].join("\n"),
    );
    await api.run("context_update", { id: "nodes/broken", source: SOURCE }, ctx);
    const doc = await ctx.storage.readDocument("nodes/broken");
    expect(doc.frontmatter.source).toEqual(SOURCE);
  });
});
