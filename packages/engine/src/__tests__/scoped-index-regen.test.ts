/**
 * Publishing one document rewrites only its own folder's INDEX.md (a folder's
 * INDEX.md lists only that folder's docs), while context.yaml is still rebuilt
 * and agent-config files are left alone when their content didn't change.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

describe("publish regenerates only the touched folder's INDEX.md", () => {
  let ctx: OperationContext;
  let dir: string;
  const api = createEngineApi();

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
    await api.run("context_create", { id: "nodes/alpha/doc-a", title: "Doc A", content: "a", publish: false }, ctx);
    await api.run("context_create", { id: "nodes/beta/doc-b", title: "Doc B", content: "b", publish: false }, ctx);
    await ctx.storage.regenerateIndex();

    const betaIndex = join(dir, "nodes/beta/INDEX.md");
    const claudeMd = join(dir, "CLAUDE.md");
    const betaBefore = await readFile(betaIndex, "utf-8");
    // generated_at is millisecond-resolution; make sure a rewrite would differ.
    await new Promise((r) => setTimeout(r, 5));

    await api.run("context_publish", { id: "nodes/alpha/doc-a" }, ctx);

    expect(await readFile(betaIndex, "utf-8")).toBe(betaBefore);
    expect(await readFile(join(dir, "nodes/alpha/INDEX.md"), "utf-8")).toMatch(
      /\[Doc A\]\(contextnest:\/\/nodes\/alpha\/doc-a\) \| document \| published/,
    );
    expect(await readFile(join(dir, "context.yaml"), "utf-8")).toContain("id: nodes/alpha/doc-a");

    // Nothing changed since: a second rebuild leaves the agent config alone.
    const claudeMtime = (await stat(claudeMd)).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    await ctx.storage.regenerateIndex({ changedIds: ["nodes/alpha/doc-a"] });
    expect((await stat(claudeMd)).mtimeMs).toBe(claudeMtime);
  });
});
