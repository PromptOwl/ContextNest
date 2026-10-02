import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";

/**
 * Every publish seals a checkpoint. Sealing used to read every document's
 * history.yaml, so one publish cost one read per document in the vault — on a
 * network-backed mount, close to a minute for a governance approval. The seal
 * now reuses the previous head's chain hash for each document whose version is
 * unchanged, and reads only the rest.
 *
 * The risk is a seal that binds a stale hash, so each case checks the head
 * against a fresh read of disk and against the full integrity verify.
 */

const draft = (title: string): string =>
  `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n# ${title}\n\nbody\n`;

describe("checkpoint seal — reads only the histories that changed", () => {
  let root: string;
  let storage: NestStorage;

  async function publish(id: string, body: string): Promise<void> {
    if (!(await storage.discoverDocuments()).some((d) => d.id === id)) {
      await storage.writeDocument(id, draft(id));
    }
    const node = await storage.readDocument(id);
    node.body = `\n${body}\n`;
    await storage.writeDocument(id, serializeDocument(node));
    await publishDocument(storage, id, { editedBy: "tester" });
  }

  /** The head must seal each published doc's latest chain hash, and verify. */
  async function expectHeadMatchesDisk(): Promise<void> {
    const state = await storage.readCheckpointChainState();
    if (state.kind !== "head") throw new Error(`no head: ${state.kind}`);
    const fresh = await storage.findAllHistories();
    const published = (await storage.discoverDocuments()).filter(
      (d) => d.frontmatter.status === "published",
    );
    for (const doc of published) {
      const entry = fresh.get(doc.id)!.versions.find((v) => v.version === doc.frontmatter.version)!;
      expect(state.checkpoint.document_chain_hashes[doc.id]).toBe(entry.chain_hash);
    }
    const report = await storage.verifyVaultIntegrity();
    expect(report.errors).toEqual([]);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cp-incr-"));
    storage = new NestStorage(root);
    await storage.init("Incremental Checkpoint Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads only the published document's history, never the whole vault", async () => {
    for (let i = 0; i < 10; i++) await publish(`nodes/doc-${i}`, `v1 ${i}`);
    const findAll = vi.spyOn(storage, "findAllHistories");
    const readHistory = vi.spyOn(storage, "readHistory");

    await publish("nodes/doc-3", "v2");

    expect(findAll).not.toHaveBeenCalled();
    // The publish itself reads doc-3's history; the seal adds no other doc.
    const others = readHistory.mock.calls.filter(([id]) => id !== "nodes/doc-3");
    expect(others).toEqual([]);
    await expectHeadMatchesDisk();
  });

  it("re-reads a history rewritten without a version bump (repair re-anchor)", async () => {
    await publish("nodes/a", "a1");
    await publish("nodes/b", "b1");
    // Re-hash a's latest entry in place, as repairLatestVersion does.
    const history = (await storage.readHistory("nodes/a"))!;
    history.versions.at(-1)!.chain_hash = `sha256:${"0".repeat(64)}`;
    await storage.writeHistory("nodes/a", history);
    await publish("nodes/b", "b2");
    const state = await storage.readCheckpointChainState();
    if (state.kind !== "head") throw new Error("no head");
    const fresh = (await storage.readHistory("nodes/a"))!;
    expect(state.checkpoint.document_chain_hashes["nodes/a"]).toBe(fresh.versions.at(-1)!.chain_hash);
  });

  it("does not reuse a deleted document's hash for a re-created one at the same version", async () => {
    await publish("nodes/a", "first life");
    await publish("nodes/b", "b1");
    await storage.deleteDocument("nodes/a");
    await publish("nodes/a", "second life");
    await expectHeadMatchesDisk();
  });

  it("matches a full re-read when another storage instance published in between", async () => {
    await publish("nodes/a", "a1");
    await publish("nodes/b", "b1");
    // A second process: its own instance, its own touched set.
    const other = new NestStorage(root);
    const node = await other.readDocument("nodes/a");
    node.body = "\nfrom elsewhere\n";
    await other.writeDocument("nodes/a", serializeDocument(node));
    await publishDocument(other, "nodes/a", { editedBy: "other" });
    await publish("nodes/b", "b2");
    await expectHeadMatchesDisk();
  });
});
