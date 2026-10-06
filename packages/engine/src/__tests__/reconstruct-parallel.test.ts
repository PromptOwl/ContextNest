/**
 * Version replay reads its keyframe and diffs together (each read is a round
 * trip on a network mount), and still applies them in order and fails exactly
 * where the sequential walk did.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { createEngineApi } from "../api/index.js";
import { reconstructFromHistory } from "../reconstruct.js";

describe("reconstructFromHistory reads artifacts in parallel", () => {
  let dir: string;
  let storage: NestStorage;
  const id = "nodes/alpha/doc";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-reconstruct-"));
    storage = new NestStorage(dir);
    const ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester",
    };
    const api = createEngineApi();
    await api.run("context_create", { id, title: "Doc", content: "body 1" }, ctx);
    for (let v = 2; v <= 6; v++) {
      const node = await storage.readDocument(id);
      node.body = `\nbody ${v}\n`;
      await storage.writeDocument(id, serializeDocument(node));
      await api.run("context_publish", { id }, ctx);
    }
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Storage readers that record the peak number of reads in flight. */
  const tracked = () => {
    let inFlight = 0;
    let peak = 0;
    const wrap =
      (read: (v: number) => Promise<string | null>) =>
      async (v: number) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await read(v);
        } finally {
          inFlight--;
        }
      };
    return {
      readKeyframe: wrap((v) => storage.readKeyframe(id, v)),
      readDiff: wrap((v) => storage.readDiff(id, v)),
      peak: () => peak,
    };
  };

  it("rebuilds v6 from the v1 keyframe and five diffs, all read at once", async () => {
    const history = (await storage.readHistory(id))!;
    const r = tracked();

    const content = await reconstructFromHistory(id, history, 6, r.readKeyframe, r.readDiff);

    expect(content).toBe(serializeDocument(await storage.readDocument(id)));
    expect(r.peak()).toBe(6);
  });

  it("a missing keyframe still wins over a later failing diff read", async () => {
    const history = (await storage.readHistory(id))!;
    const content = reconstructFromHistory(
      id,
      history,
      4,
      async () => null,
      async () => {
        throw new Error("diff read failed");
      },
    );
    await expect(content).rejects.toThrow(/Keyframe file for version 1 not found/);
  });

  it("a failing diff surfaces at its own position", async () => {
    const history = (await storage.readHistory(id))!;
    const content = reconstructFromHistory(
      id,
      history,
      5,
      (v) => storage.readKeyframe(id, v),
      async (v) => {
        if (v === 3) throw new Error("diff v3 unreadable");
        return storage.readDiff(id, v);
      },
    );
    await expect(content).rejects.toThrow("diff v3 unreadable");
  });
});
