import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { generateContextYaml } from "../index-generator.js";
import { generateIndexMd } from "../index-md-generator.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

/**
 * Whatever a write does to keep the index and the checkpoint current, the
 * result must be what a full crawl of the vault would produce. Writes are
 * moving off the full crawl (a manifest of what each document contributes),
 * and this is the oracle: random sequences of every write op, and after each
 * one the on-disk state is compared with a from-scratch rebuild.
 *
 * - context.yaml must equal generateContextYaml over every published doc.
 * - Each folder's INDEX.md must equal generateIndexMd over that folder.
 * - A seal must bind every published doc at its version, with the hash its
 *   history holds — and nothing that is no longer published.
 */

const TITLES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
const FOLDERS = ["a", "b"];

/** Deterministic PRNG (mulberry32) so a failing seed replays exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Timestamps differ between any two runs; nothing else may. */
const stamp = /\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g;
const normalize = (text: string) => text.replace(stamp, "<ts>");

describe("index and checkpoint equal a full rebuild after any write sequence", () => {
  let root: string;
  let ctx: OperationContext;
  const api = createEngineApi();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-index-eq-"));
    const storage = new NestStorage(root);
    await storage.init("Equivalence Vault");
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectIndexMatchesCrawl(step: string): Promise<void> {
    const storage = ctx.storage;
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const published = docs.filter((d) => d.frontmatter.status === "published");
    const head = await storage.readLatestCheckpoint();

    const expected = generateContextYaml(published, await storage.readConfig(), head);
    const actual = await storage.readContextYaml();
    expect(actual, step).not.toBeNull();
    const { generated_at: _a, ...actualRest } = actual!;
    const { generated_at: _e, ...expectedRest } = expected;
    expect(actualRest, step).toEqual(expectedRest);

    const folders = new Map<string, typeof docs>();
    for (const doc of docs) {
      const folder = doc.id.split("/").slice(0, -1).join("/");
      if (!folder) continue;
      folders.set(folder, [...(folders.get(folder) ?? []), doc]);
    }
    for (const [folder, folderDocs] of folders) {
      const title = folder.split("/").pop()!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const onDisk = await readFile(join(root, folder, "INDEX.md"), "utf-8");
      expect(normalize(onDisk), `${step}: ${folder}/INDEX.md`).toBe(
        normalize(generateIndexMd(folder, title, folderDocs)),
      );
    }
  }

  async function expectSealMatchesCrawl(step: string): Promise<void> {
    const storage = ctx.storage;
    const head = await storage.readLatestCheckpoint();
    const published = (await storage.discoverDocuments()).filter((d) => d.frontmatter.status === "published");
    const versions: Record<string, number> = {};
    const hashes: Record<string, string> = {};
    for (const doc of published) {
      const version = doc.frontmatter.version || 1;
      versions[doc.id] = version;
      const entry = (await storage.readHistory(doc.id))?.versions.find((v) => v.version === version);
      if (entry) hashes[doc.id] = entry.chain_hash;
    }
    expect(head?.document_versions, step).toEqual(versions);
    expect(head?.document_chain_hashes, step).toEqual(hashes);
  }

  /** A body linking to other docs by title and by id, so edges depend on the whole vault. */
  function body(next: () => number, ids: string[]): string {
    const title = TITLES[Math.floor(next() * TITLES.length)];
    const lines = [`Links to [[${title}]].`];
    if (ids.length && next() < 0.5) {
      lines.push(`See [ref](contextnest://${ids[Math.floor(next() * ids.length)]}).`);
    }
    lines.push(`Note ${Math.floor(next() * 1e6)}.`);
    return lines.join("\n\n");
  }

  async function runSequence(seed: number, steps: number): Promise<void> {
    const next = rng(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)];
    let created = 0;

    for (let i = 0; i < steps; i++) {
      const docs = await ctx.storage.discoverDocuments({ includeRetired: true });
      const ids = docs.map((d) => d.id);
      const live = docs.filter((d) => d.frontmatter.status !== "forgotten").map((d) => d.id);
      const op = !live.length || next() < 0.3 ? "create" : pick(["edit", "retitle", "unpublish", "reject", "publish", "delete", "forget"]);
      const id = live.length ? pick(live) : "";
      const before = await ctx.storage.readLatestCheckpointNumber();
      const step = `seed ${seed} step ${i}: ${op} ${id}`;

      try {
        switch (op) {
          case "create":
            await api.run("context_create", {
              title: pick(TITLES),
              id: `nodes/${pick(FOLDERS)}/doc-${created++}`,
              content: body(next, ids),
              tags: [`#t${Math.floor(next() * 3)}`],
              publish: next() < 0.8,
            }, ctx);
            break;
          case "edit":
            await api.run("context_update", { id, content: body(next, ids) }, ctx);
            break;
          case "retitle":
            await api.run("context_update", { id, title: pick(TITLES) }, ctx);
            break;
          case "unpublish":
            await api.run("context_update", { id, status: "draft" }, ctx);
            break;
          case "reject":
            await api.run("context_update", { id, status: "rejected" }, ctx);
            break;
          case "publish":
            await api.run("context_publish", { id }, ctx);
            break;
          case "delete":
            await api.run("context_delete", { id }, ctx);
            break;
          case "forget":
            await api.run("context_forget", { id, reason_code: "user_request" }, ctx);
            break;
        }
        landed.add(op);
      } catch {
        // Refusals (publishing a rejected doc, a forgotten path) are part of
        // the sequence: whatever a refused write left behind must still match.
      }

      await expectIndexMatchesCrawl(step);
      if ((await ctx.storage.readLatestCheckpointNumber()) > before) await expectSealMatchesCrawl(step);
    }

    const report = await ctx.storage.verifyVaultIntegrity();
    expect(report.errors, `seed ${seed}: verify`).toEqual([]);
  }

  const landed = new Set<string>();

  for (const seed of [1, 2, 3, 4]) {
    it(`seed ${seed}: 40 random writes`, async () => {
      await runSequence(seed, 40);
    }, 60_000);
  }

  // Refusals are swallowed above, so make sure the seeds exercise every op.
  it("the seeds landed every kind of write at least once", () => {
    expect([...landed].sort()).toEqual(
      ["create", "delete", "edit", "forget", "publish", "reject", "retitle", "unpublish"],
    );
  });
});
