import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { serializeDocument } from "../parser.js";
import { publishDocuments } from "../publish.js";
import type { ContextNode } from "../types.js";

async function makeStorage(): Promise<{ storage: NestStorage; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-bulk-"));
  return { storage: new NestStorage(dir), dir };
}

/** Write a draft node to disk at nodes/<slug> and return its id. */
async function writeDraft(
  storage: NestStorage,
  slug: string,
  extra: Partial<ContextNode["frontmatter"]> = {},
): Promise<string> {
  const id = `nodes/${slug}`;
  const node: ContextNode = {
    id,
    filePath: "",
    rawContent: "",
    frontmatter: { title: slug, type: "document", status: "draft", ...extra },
    body: `body of ${slug}`,
  };
  await storage.writeDocument(id, serializeDocument(node));
  return id;
}

describe("publishDocuments — bulk import", () => {
  let storage: NestStorage;
  let dir: string;

  beforeEach(async () => {
    ({ storage, dir } = await makeStorage());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publishes N docs and seals exactly ONE checkpoint for the batch", async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await writeDraft(storage, `doc-${i}`));

    const result = await publishDocuments(storage, ids, { editedBy: "importer" });

    expect(result.published).toHaveLength(12);
    expect(result.failed).toHaveLength(0);
    expect(result.checkpointNumber).toBe(1);
    // Every published entry carries a version + chain hash.
    for (const p of result.published) {
      expect(p.version).toBe(1);
      expect(p.chainHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // The whole batch produced ONE checkpoint, not one-per-doc.
    const history = await storage.readCheckpointHistory();
    expect(history?.checkpoints).toHaveLength(1);

    // All docs are actually published on disk.
    for (const id of ids) {
      const doc = await storage.readDocument(id);
      expect(doc.frontmatter.status).toBe("published");
      expect(doc.frontmatter.version).toBe(1);
    }
  });

  it("keeps the hash chains valid after a bulk publish", async () => {
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await writeDraft(storage, `n-${i}`));
    await publishDocuments(storage, ids, { editedBy: "importer" });

    const report = await storage.verifyVaultIntegrity();
    expect(report.valid).toBe(true);
  });

  it("isolates failures — a rejected doc lands in failed[], the rest publish", async () => {
    const good1 = await writeDraft(storage, "good-1");
    const bad = await writeDraft(storage, "retired", { status: "rejected" });
    const good2 = await writeDraft(storage, "good-2");

    const result = await publishDocuments(storage, [good1, bad, good2], {
      editedBy: "importer",
    });

    expect(result.published.map((p) => p.id).sort()).toEqual([good1, good2].sort());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(bad);
    // Checkpoint still sealed over the two good docs.
    expect(result.checkpointNumber).toBe(1);
    // The rejected doc was never flipped to published.
    expect((await storage.readDocument(bad)).frontmatter.status).toBe("rejected");
  });

  it("ticks onProgress once per doc, failures included", async () => {
    const good1 = await writeDraft(storage, "prog-1");
    const bad = await writeDraft(storage, "prog-rejected", { status: "rejected" });
    const good2 = await writeDraft(storage, "prog-2");
    const ticks: Array<[number, number]> = [];

    await publishDocuments(storage, [good1, bad, good2], {
      editedBy: "importer",
      onProgress: (done, total) => ticks.push([done, total]),
    });

    // One tick per input id — a failed doc still advances the bar.
    expect(ticks.map(([done]) => done)).toEqual([1, 2, 3]);
    expect(ticks.every(([, total]) => total === 3)).toBe(true);
  });

  it("returns null checkpoint when nothing publishes", async () => {
    const bad = await writeDraft(storage, "only-rejected", { status: "rejected" });
    const result = await publishDocuments(storage, [bad], { editedBy: "importer" });

    expect(result.published).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.checkpointNumber).toBeNull();
  });
});
