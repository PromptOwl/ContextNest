import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";

/**
 * The whole-vault crawls (discoverDocuments, findAllHistories) read files in
 * bounded-parallel batches rather than one at a time — on a network-backed
 * mount a serial read costs one round trip per file, and a publish runs three
 * such crawls. This guards the fold that reassembles those batches: with more
 * files than fit in one batch, nothing may be dropped, duplicated, or reordered.
 */
describe("whole-vault crawls batch without losing or reordering files", () => {
  let root: string;
  let storage: NestStorage;
  // Comfortably more than one batch, so the fold runs several times.
  const COUNT = 70;
  const pad = (i: number) => String(i).padStart(3, "0");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-crawl-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("discovers every document, in id order", async () => {
    for (let i = 0; i < COUNT; i++) {
      await writeFile(
        join(root, "nodes", `doc-${pad(i)}.md`),
        `---\ntitle: Doc ${pad(i)}\ntype: document\nstatus: published\n---\n\nbody ${i}\n`,
        "utf-8",
      );
    }
    const docs = await storage.discoverDocuments();
    expect(docs).toHaveLength(COUNT);
    expect(docs.map((d) => d.id)).toEqual(
      Array.from({ length: COUNT }, (_, i) => `nodes/doc-${pad(i)}`),
    );
  });

  it("collects every history, and reports each unreadable one once", async () => {
    for (let i = 0; i < COUNT; i++) {
      const dir = join(root, "nodes", ".versions", `doc-${pad(i)}`);
      await mkdir(dir, { recursive: true });
      // Every third history is deliberate garbage — the crawl must skip it and
      // report it, not abort the batch it happened to land in.
      const hash = (seed: string) => `sha256:${(seed + pad(i)).padEnd(64, "0")}`;
      const good =
        `keyframe_interval: 10\nversions:\n  - version: 1\n` +
        `    edited_by: a@b.io\n    edited_at: "2026-01-01T00:00:00.000Z"\n` +
        `    content_hash: ${hash("a")}\n    chain_hash: ${hash("b")}\n`;
      await writeFile(
        join(dir, "history.yaml"),
        i % 3 === 0 ? "versions: [oops\n" : good,
        "utf-8",
      );
    }

    const unreadable: string[] = [];
    const histories = await storage.findAllHistories((id) => unreadable.push(id));

    const badCount = Math.ceil(COUNT / 3);
    expect(histories.size).toBe(COUNT - badCount);
    expect(unreadable).toHaveLength(badCount);
    expect(new Set(unreadable).size).toBe(badCount);
    expect(histories.has("nodes/doc-001")).toBe(true);
    expect(histories.has("nodes/doc-000")).toBe(false);
  });
});
