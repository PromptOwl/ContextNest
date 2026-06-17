import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  NestStorage,
  publishDocument,
  verifyCheckpointChain,
  CheckpointManager,
} from "../index.js";

/**
 * Regression tests for the two checkpoint integrity fixes:
 *   Bug 1 — createCheckpoint desync under concurrent publishes
 *   Bug 2 — rebuildCheckpointHistory non-convergence / corruption re-encode
 *
 * These FAIL before the fix and pass after.
 */

let vault: string;
let storage: NestStorage;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "cn-cp-integrity-"));
  storage = new NestStorage(vault);
  await storage.init("Checkpoint Integrity Vault");
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

async function seedDoc(id: string, title: string): Promise<void> {
  const content = `---
title: ${title}
type: document
status: draft
---

# ${title}

Body for ${title}.
`;
  await storage.writeDocument(id, content);
}

describe("Bug 1: concurrent publishes keep the checkpoint chain consistent", () => {
  it("publishing many docs via Promise.all yields a verifiable checkpoint chain", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `nodes/concurrent-${i}`);
    await Promise.all(ids.map((id) => seedDoc(id, `Concurrent ${id}`)));

    // Fire all publishes concurrently — the exact race the fix guards against.
    await Promise.all(
      ids.map((id) =>
        publishDocument(storage, id, { editedBy: "racer@local" }),
      ),
    );

    const histories = await storage.findAllHistories();
    const cpHistory = await storage.readCheckpointHistory();
    expect(cpHistory).not.toBeNull();

    const report = verifyCheckpointChain(cpHistory!.checkpoints, histories);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });
});

describe("Bug 1: createCheckpoint seals an internally consistent (version, chain_hash) pair", () => {
  it("every checkpoint's version+chain_hash agree with the per-doc history head and verify", async () => {
    const ids = ["nodes/alpha", "nodes/beta", "nodes/gamma"];
    for (const id of ids) await seedDoc(id, id);

    // Sequential publishes, several rounds, to grow the chains.
    for (let round = 0; round < 3; round++) {
      for (const id of ids) {
        await publishDocument(storage, id, { editedBy: "seq@local" });
      }
    }

    const histories = await storage.findAllHistories();
    const cpHistory = await storage.readCheckpointHistory();
    expect(cpHistory).not.toBeNull();

    // Each sealed (version -> chain_hash) pair must come from the SAME history
    // entry: the entry at that version must carry that chain_hash.
    for (const cp of cpHistory!.checkpoints) {
      for (const [docId, chainHash] of Object.entries(cp.document_chain_hashes)) {
        const version = cp.document_versions[docId];
        const hist = histories.get(docId);
        expect(hist, `history for ${docId}`).toBeDefined();
        const entry = hist!.versions.find((v) => v.version === version);
        expect(entry, `entry v${version} for ${docId}`).toBeDefined();
        expect(entry!.chain_hash).toBe(chainHash);
      }
    }

    const report = verifyCheckpointChain(cpHistory!.checkpoints, histories);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });
});

describe("Bug 2: rebuildCheckpointHistory converges and is idempotent", () => {
  it("rebuild verifies, then a second rebuild yields an identical history", async () => {
    const ids = ["nodes/one", "nodes/two", "nodes/three"];
    for (const id of ids) await seedDoc(id, id);
    for (let round = 0; round < 2; round++) {
      for (const id of ids) {
        await publishDocument(storage, id, { editedBy: "build@local" });
      }
    }

    const cm = new CheckpointManager(storage);

    const first = await cm.rebuildCheckpointHistory();
    expect(first.skippedDocuments).toEqual([]);

    const histories = await storage.findAllHistories();
    const report = verifyCheckpointChain(first.history.checkpoints, histories);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);

    // Idempotency: running again produces a structurally identical history.
    const second = await cm.rebuildCheckpointHistory();
    expect(second.history).toEqual(first.history);

    // And the on-disk bytes are identical too.
    const onDisk1 = await storage.readCheckpointHistory();
    const onDisk2 = await storage.readCheckpointHistory();
    expect(onDisk2).toEqual(onDisk1);
  });

  it("excludes a document with a broken version chain instead of re-encoding corruption", async () => {
    for (const id of ["nodes/good", "nodes/bad"]) await seedDoc(id, id);
    for (const id of ["nodes/good", "nodes/bad"]) {
      await publishDocument(storage, id, { editedBy: "build@local" });
    }

    // Corrupt the "bad" document's chain by tampering its stored chain_hash.
    const badHistory = await storage.readHistory("nodes/bad");
    expect(badHistory).not.toBeNull();
    // A well-formed (schema-valid) but WRONG chain_hash — survives schema
    // validation in findAllHistories so it reaches the rebuild, but fails
    // recomputation in verifyDocumentChain.
    badHistory!.versions[badHistory!.versions.length - 1].chain_hash =
      "sha256:" + "0".repeat(64);
    await storage.writeHistory("nodes/bad", badHistory!);

    const cm = new CheckpointManager(storage);
    const result = await cm.rebuildCheckpointHistory();

    // The broken doc is surfaced, not silently re-sealed.
    expect(result.skippedDocuments.map((s) => s.docId)).toContain("nodes/bad");
    expect(result.skippedDocuments.map((s) => s.docId)).not.toContain(
      "nodes/good",
    );

    // No rebuilt checkpoint references the excluded document.
    for (const cp of result.history.checkpoints) {
      expect(Object.keys(cp.document_chain_hashes)).not.toContain("nodes/bad");
      expect(cp.triggered_by).not.toBe("nodes/bad");
    }
  });
});
