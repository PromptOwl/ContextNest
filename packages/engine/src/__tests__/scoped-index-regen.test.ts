/**
 * Publishing one document rewrites only its own folder's INDEX.md (a folder's
 * INDEX.md lists only that folder's docs), while context.yaml is still rebuilt
 * and agent-config files are left alone when their content didn't change.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { approveReview } from "../review.js";

describe("publish regenerates only the touched folder's INDEX.md", () => {
  let ctx: OperationContext;
  let dir: string;
  const api = createEngineApi();

  const create = (id: string, extra: Record<string, unknown> = {}) =>
    api.run<{ id: string }>("context_create", { id, title: id, content: "x", publish: false, ...extra }, ctx);
  const index = (folder: string) => readFile(join(dir, folder, "INDEX.md"), "utf-8");
  // generated_at is millisecond-resolution: a rewrite after this always differs.
  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-scoped-index-"));
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

  it("leaves other folders' INDEX.md untouched and still indexes the doc", async () => {
    await create("nodes/alpha/doc-a");
    await create("nodes/beta/doc-b");
    await ctx.storage.regenerateIndex();
    const betaBefore = await index("nodes/beta");
    await tick();

    await api.run("context_publish", { id: "nodes/alpha/doc-a" }, ctx);

    expect(await index("nodes/beta")).toBe(betaBefore);
    expect(await index("nodes/alpha")).toMatch(
      /\[nodes\/alpha\/doc-a\]\(contextnest:\/\/nodes\/alpha\/doc-a\) \| document \| published/,
    );
    expect(await readFile(join(dir, "context.yaml"), "utf-8")).toContain("id: nodes/alpha/doc-a");
  });

  it("skips rewriting an agent config whose content is unchanged", async () => {
    await create("nodes/alpha/doc-a");
    await api.run("context_publish", { id: "nodes/alpha/doc-a" }, ctx);
    // Pin the mtime in the past: any rewrite moves it to now, whatever the
    // filesystem's timestamp granularity.
    const claudeMd = join(dir, "CLAUDE.md");
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(claudeMd, past, past);

    await ctx.storage.regenerateIndex({ changedIds: ["nodes/alpha/doc-a"] });

    expect((await stat(claudeMd)).mtime.getTime()).toBe(past.getTime());
  });

  it("nested folder: rewrites only the innermost folder, not its parent", async () => {
    await create("nodes/a/sibling");
    await create("nodes/a/b/doc");
    await ctx.storage.regenerateIndex();
    const parentBefore = await index("nodes/a");
    const innerBefore = await index("nodes/a/b");
    await tick();

    await api.run("context_publish", { id: "nodes/a/b/doc" }, ctx);

    expect(await index("nodes/a")).toBe(parentBefore);
    expect(await index("nodes/a/b")).not.toBe(innerBefore);
    expect(await index("nodes/a/b")).toMatch(/\| published \|/);
  });

  it("top-level doc: rewrites the top folder's INDEX.md, not its subfolders'", async () => {
    await create("nodes/alpha/doc-a");
    // A bare slug lands directly under the vault's top documents folder.
    const { id } = await create("root-doc");
    const top = id.split("/").slice(0, -1).join("/");
    await ctx.storage.regenerateIndex();
    const alphaBefore = await index("nodes/alpha");
    const topBefore = await index(top);
    await tick();

    await api.run("context_publish", { id }, ctx);

    expect(await index("nodes/alpha")).toBe(alphaBefore);
    expect(await index(top)).not.toBe(topBefore);
    expect(await readFile(join(dir, "context.yaml"), "utf-8")).toContain(`id: ${id}`);
  });

  it("review approve of a held new doc rewrites only its folder", async () => {
    await create("nodes/beta/doc-b");
    const { id } = await create("nodes/alpha/held", { publish: undefined, review: true });
    await ctx.storage.regenerateIndex();
    const betaBefore = await index("nodes/beta");
    await tick();

    await approveReview(ctx.storage, id, { actor: "reviewer" });

    expect(await index("nodes/beta")).toBe(betaBefore);
    expect(await index("nodes/alpha")).toMatch(/\| published \|/);
  });

  it("review approve of a held edit rewrites only its folder", async () => {
    await create("nodes/beta/doc-b");
    await create("nodes/alpha/pub", { publish: true });
    await api.run("context_update", { id: "nodes/alpha/pub", content: "edited", review: true }, ctx);
    await ctx.storage.regenerateIndex();
    const betaBefore = await index("nodes/beta");
    const alphaBefore = await index("nodes/alpha");
    await tick();

    await approveReview(ctx.storage, "nodes/alpha/pub", { actor: "reviewer" });

    expect(await index("nodes/beta")).toBe(betaBefore);
    expect(await index("nodes/alpha")).not.toBe(alphaBefore);
  });
});
