/**
 * Publish reads each document's history.yaml ONCE and never reads the document
 * back after writing it — every read is a round trip on a network mount. The
 * outputs must be exactly what the re-reading path produced: chains verify,
 * every version reconstructs, the checkpoint seals each doc's real chain hash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

describe("publish I/O: one history read per document, same results", () => {
  let ctx: OperationContext;
  let storage: NestStorage;
  let dir: string;
  const api = createEngineApi();

  /** Published v1, then an edit saved as pending — the next publish is a v2 diff. */
  const pendingEdit = async (id: string, body: string): Promise<void> => {
    await api.run("context_create", { id, title: id, content: "first body" }, ctx);
    const node = await storage.readDocument(id);
    node.frontmatter.status = "pending_review";
    node.body = `\n${body}\n`;
    await storage.writeDocument(id, serializeDocument(node));
  };

  /** Every chain verifies, every version rebuilds, the head seals the real hashes. */
  const assertIntact = async (ids: string[]) => {
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
    const head = (await storage.readCheckpointHistory())!.checkpoints.at(-1)!;
    const versions = new VersionManager(storage);
    for (const id of ids) {
      const history = (await storage.readHistory(id))!;
      const last = history.versions.at(-1)!;
      expect(head.document_versions[id]).toBe(last.version);
      expect(head.document_chain_hashes[id]).toBe(last.chain_hash);
      const live = serializeDocument(await storage.readDocument(id));
      expect(await versions.reconstructVersion(id, last.version)).toBe(live);
    }
  };

  const countFor = (spy: { mock: { calls: unknown[][] } }, id: string) =>
    spy.mock.calls.filter((c) => c[0] === id).length;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-publish-io-"));
    storage = new NestStorage(dir);
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "reviewer@example.com",
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("single publish: history read once, document read once", async () => {
    await pendingEdit("nodes/alpha/doc", "second body");
    await api.run("context_create", { id: "nodes/beta/other", title: "Other", content: "other" }, ctx);
    const readHistory = vi.spyOn(storage, "readHistory");
    const readDocument = vi.spyOn(storage, "readDocument");
    const readHead = vi.spyOn(storage, "readLatestCheckpoint");

    const out = await api.run<{ version: number }>("context_publish", { id: "nodes/alpha/doc" }, ctx);

    expect(out.version).toBe(2);
    expect(countFor(readHistory, "nodes/alpha/doc")).toBe(1);
    expect(countFor(readDocument, "nodes/alpha/doc")).toBe(1);
    // The index rebuild reuses the checkpoint the publish just sealed.
    expect(readHead).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    const doc = await storage.readDocument("nodes/alpha/doc");
    expect(doc.frontmatter.status).toBe("published");
    expect(doc.body).toContain("second body");
    await assertIntact(["nodes/alpha/doc", "nodes/beta/other"]);
    const contextYaml = await readFile(join(dir, "context.yaml"), "utf-8");
    const head = (await storage.readCheckpointHistory())!.checkpoints.at(-1)!;
    expect(contextYaml).toContain(`checkpoint: ${head.checkpoint}\n`);
  });

  it("bulk approval via context_import: one history read per doc, one checkpoint, scoped index", async () => {
    const ids = ["nodes/alpha/a1", "nodes/alpha/a2", "nodes/beta/b1", "nodes/beta/b2"];
    for (const id of ids) await pendingEdit(id, `edited ${id}`);
    await api.run("context_create", { id: "nodes/gamma/untouched", title: "Untouched", content: "x" }, ctx);
    await storage.regenerateIndex();
    const gammaIndex = await readFile(join(dir, "nodes/gamma/INDEX.md"), "utf-8");
    const checkpointsBefore = (await storage.readCheckpointHistory())!.checkpoints.length;
    await new Promise((r) => setTimeout(r, 5));
    const readHistory = vi.spyOn(storage, "readHistory");

    const out = await api.run<{ published: { id: string; version: number }[]; failed: unknown[] }>(
      "context_import",
      { ids, note: "Approved in bulk review" },
      ctx,
    );

    expect(out.failed).toEqual([]);
    expect(out.published.every((p) => p.version === 2)).toBe(true);
    for (const id of ids) expect(countFor(readHistory, id)).toBe(1);
    vi.restoreAllMocks();

    expect((await storage.readCheckpointHistory())!.checkpoints.length).toBe(checkpointsBefore + 1);
    expect(await readFile(join(dir, "nodes/gamma/INDEX.md"), "utf-8")).toBe(gammaIndex);
    expect(await readFile(join(dir, "nodes/alpha/INDEX.md"), "utf-8")).toMatch(/nodes\/alpha\/a1\) \| document \| published/);
    for (const id of ids) {
      expect((await storage.readHistory(id))!.versions.at(-1)!.note).toBe("Approved in bulk review");
    }
    await assertIntact([...ids, "nodes/gamma/untouched"]);
  });

  it("seeded publish (version > 1, no history) still seeds then publishes on one chain", async () => {
    const id = "nodes/alpha/legacy";
    await storage.writeDocument(
      id,
      serializeDocument({
        id,
        filePath: "",
        rawContent: "",
        frontmatter: { title: "Legacy", type: "document", status: "draft", version: 3 },
        body: "\nlegacy body\n",
      }),
    );

    const out = await api.run<{ version: number }>("context_publish", { id }, ctx);

    expect(out.version).toBe(4);
    const history = (await storage.readHistory(id))!;
    expect(history.versions.map((v) => v.version)).toEqual([3, 4]);
    expect(history.versions[0].note).toMatch(/auto-seeded/);
    await assertIntact([id]);
  });

  it("many sequential publishes keep diffs reconstructable across the keyframe interval", async () => {
    const id = "nodes/alpha/busy";
    await api.run("context_create", { id, title: "Busy", content: "v1" }, ctx);
    for (let v = 2; v <= 13; v++) {
      const node = await storage.readDocument(id);
      node.body = `\nbody at ${v}\n`;
      await storage.writeDocument(id, serializeDocument(node));
      await api.run("context_publish", { id }, ctx);
    }
    const history = (await storage.readHistory(id))!;
    const versions = new VersionManager(storage);
    for (const entry of history.versions) {
      await expect(versions.reconstructVersion(id, entry.version)).resolves.toContain(
        entry.version === 1 ? "v1" : `body at ${entry.version}`,
      );
    }
    await assertIntact([id]);
  });
});
