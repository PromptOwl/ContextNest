/**
 * A large document with a long keyframe+diff chain must not hold the event
 * loop: replaying the chain lets other work in between patches, and a new
 * version of a huge document is sealed as a keyframe instead of a full-text
 * diff (which would also need the previous version rebuilt first).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createPatch } from "diff";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { createEngineApi } from "../api/index.js";
import { reconstructFromHistory } from "../reconstruct.js";

describe("large documents do not stall the event loop", () => {
  let dir: string;
  let storage: NestStorage;
  let ctx: { storage: NestStorage; query: GraphQueryEngine; versions: VersionManager; actor: string };
  const api = createEngineApi();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-large-doc-"));
    storage = new NestStorage(dir);
    ctx = { storage, query: new GraphQueryEngine(storage), versions: new VersionManager(storage), actor: "tester" };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("a long reconstruct yields to the event loop", async () => {
    const A = `---\ntitle: X\n---\n${"y\n".repeat(200_000)}`;
    const B = `${A}z\n`;
    const there = createPatch("x", A, B);
    const back = createPatch("x", B, A);
    const versions = Array.from({ length: 30 }, (_, i) => ({
      version: i + 1,
      ...(i === 0 ? { keyframe: true } : {}),
      edited_by: "t",
      edited_at: "2026-01-01T00:00:00Z",
      content_hash: "h",
      chain_hash: "c",
    }));
    // Turns of the event loop that ran while the replay was in progress. The
    // readers are synchronous, so without yields there are none, whatever the
    // machine's speed.
    let turns = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const replay = reconstructFromHistory(
      "d",
      { keyframe_interval: 100, versions },
      30,
      (v) => (v === 1 ? A : null),
      (v) => (v % 2 === 0 ? there : back),
    );
    const before = turns;
    try {
      expect(await replay).toBe(B);
    } finally {
      running = false;
    }
    expect(turns - before).toBeGreaterThanOrEqual(5);
  });

  it("a huge document's next version is a keyframe, sealed without replaying the chain", async () => {
    const id = "nodes/big/doc";
    const body = "a line of text in a very large document\n".repeat(60_000); // ~2.4 MB
    await api.run("context_create", { id, title: "Big", content: body }, ctx);
    const node = await storage.readDocument(id);
    node.body = `${node.body}one more line\n`;
    await storage.writeDocument(id, serializeDocument(node));

    const replays = vi.spyOn(VersionManager.prototype, "reconstructVersion");
    const out = await api.run<{ published: { id: string }[] }>("context_import", { ids: [id] }, ctx);
    expect(out.published.map((p) => p.id)).toEqual([id]);
    expect(replays).not.toHaveBeenCalled();
    replays.mockRestore();

    const latest = (await storage.readHistory(id))!.versions.at(-1)!;
    expect(latest.keyframe).toBe(true);
    expect(await storage.readDiff(id, latest.version)).toBeNull();
    // Byte-identical to what was published.
    expect(await ctx.versions.reconstructVersion(id, latest.version)).toBe(
      serializeDocument(await storage.readDocument(id)),
    );
  });

  it("a document crossing the size line both ways keeps every version readable and the chain valid", async () => {
    const id = "nodes/big/cross";
    const big = "a line of text in a very large document\n".repeat(30_000); // ~1.2 MB
    await api.run("context_create", { id, title: "Cross", content: big }, ctx);
    const published = new Map<number, string>([[1, serializeDocument(await storage.readDocument(id))]]);
    const publish = async (body: string) => {
      const node = await storage.readDocument(id);
      node.body = body;
      await storage.writeDocument(id, serializeDocument(node));
      const out = await api.run<{ version: number }>("context_publish", { id }, ctx);
      published.set(out.version, serializeDocument(await storage.readDocument(id)));
    };
    await publish(`${big}still big\n`); // v2: over the line
    await publish("small now\n"); // v3: under it, but v2 is over: a keyframe, never a diff from 1 MB
    await publish("small now\nand edited\n"); // v4: both sides small: a diff
    await publish(`${big}big again\n`); // v5: over the line again

    const versions = (await storage.readHistory(id))!.versions;
    expect(versions.map((e) => [e.version, e.keyframe === true])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
      [5, true],
    ]);
    for (const [v, content] of published) {
      expect(await ctx.versions.reconstructVersion(id, v)).toBe(content);
    }
    // A size keyframe has no stored diff to show; a small version still does.
    expect(await ctx.versions.getDiff(id, 2)).toBeNull();
    expect(await ctx.versions.getDiff(id, 4)).toContain("+and edited");
    await expect(api.run("context_verify", {}, ctx)).resolves.toMatchObject({ valid: true });
  });
});
