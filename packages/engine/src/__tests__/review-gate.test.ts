import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import {
  readReviewMode,
  setReviewMode,
  approveReview,
  rejectReview,
  listPendingReview,
  listReviewHolds,
} from "../review.js";

const api = createEngineApi();
let dir: string;
let storage: NestStorage;
let ctx: OperationContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contextnest-review-"));
  storage = new NestStorage(dir);
  await storage.init("Review Vault", "structured", undefined, { review: "on" });
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

const docPath = (id: string) => join(dir, `${id}.md`);
const checkpoints = async () => (await storage.readCheckpointHistory())?.checkpoints.length ?? 0;

describe("review setting", () => {
  it("init({review:'on'}) writes the key; plain init() does not (pre-gate vaults publish)", async () => {
    expect(await readReviewMode(storage)).toBe("on");
    const other = await mkdtemp(join(tmpdir(), "contextnest-review-legacy-"));
    try {
      const legacy = new NestStorage(other);
      await legacy.init("Legacy");
      expect(await readReviewMode(legacy)).toBeUndefined();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("setReviewMode edits only its own line", async () => {
    const cfg = join(dir, ".context", "config.yaml");
    await writeFile(cfg, `# keep me\n${await readFile(cfg, "utf-8")}`);
    await setReviewMode(storage, "off");
    const raw = await readFile(cfg, "utf-8");
    expect(raw).toContain("# keep me");
    expect(await readReviewMode(storage)).toBe("off");
  });
});

describe("held writes", () => {
  it("context_create with review:true lands as pending_review and approveReview publishes it", async () => {
    const res = await api.run<any>("context_create", { title: "Note", content: "body", review: true }, ctx);
    expect(res).toMatchObject({ status: "pending_review", checkpoint: null, held_for_review: true });
    // Nothing is sealed until approval: no version, no checkpoint.
    expect(await storage.readHistory(res.id)).toBeNull();
    expect(await checkpoints()).toBe(0);
    expect((await listPendingReview(storage)).map((i) => i.id)).toEqual([res.id]);

    const approved = await approveReview(storage, res.id, { actor: "reviewer" });
    expect(approved.version).toBe(1);
    expect(await readFile(docPath(res.id), "utf-8")).toMatch(/status: published/);
  });

  it("an edit to a published node is staged, stacks with the next one, and approves as one version", async () => {
    const { id } = await api.run<any>("context_create", { title: "Pub", content: "one" }, ctx);
    const sealed = await checkpoints();
    const first = await api.run<any>("context_update", { id, content: "two", review: true }, ctx);
    expect(first.held_for_review).toBe(true);
    expect(await checkpoints()).toBe(sealed);
    expect((await storage.readHistory(id))!.versions).toHaveLength(1);
    expect(await readFile(docPath(id), "utf-8")).toContain("one"); // published bytes untouched

    await api.run<any>("context_update", { id, append: "three", review: true }, ctx);
    const holds = await listReviewHolds(storage, id);
    expect(holds).toHaveLength(1); // the second hold superseded the first

    const approved = await approveReview(storage, id, { actor: "reviewer" });
    expect(approved.version).toBe(2);
    const body = await readFile(docPath(id), "utf-8");
    expect(body).toContain("two");
    expect(body).toContain("three");
    expect(await listReviewHolds(storage, id)).toHaveLength(0);
  });

  it("rejectReview discards a held edit and leaves the published version", async () => {
    const { id } = await api.run<any>("context_create", { title: "Keep", content: "original" }, ctx);
    await api.run<any>("context_update", { id, content: "unwanted", review: true }, ctx);
    const r = await rejectReview(storage, id, { actor: "reviewer" });
    expect(r.kind).toBe("edit");
    expect(await readFile(docPath(id), "utf-8")).toContain("original");
    expect(await listPendingReview(storage)).toHaveLength(0);
  });

  it("publish:true beats review:true (the --publish override)", async () => {
    const res = await api.run<any>("context_create", { title: "Now", content: "x", review: true, publish: true }, ctx);
    expect(res.status).toBe("published");
    expect(res.held_for_review).toBeUndefined();
  });
});
