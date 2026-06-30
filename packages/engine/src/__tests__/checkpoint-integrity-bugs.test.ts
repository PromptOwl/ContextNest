/**
 * Reproduction tests for two known checkpoint-integrity defects.
 *
 *   Bug 1 — non-atomic checkpoint seal references a superseded chain_hash.
 *           `publishDocument` reads the published-doc snapshot (publish.ts:91)
 *           and the per-doc history snapshot (publish.ts:95) in two separate
 *           phases with no lock, then hands both to `createCheckpoint`. Under
 *           rapid/concurrent publishing the doc head can advance between the
 *           two reads, so the checkpoint seals `document_versions[doc] = N`
 *           from one read but `document_chain_hashes[doc]` from the other —
 *           a checkpoint that points at a chain_hash the doc no longer has at
 *           that version. `verifyCheckpointChain` flags it as
 *           `cross_chain_mismatch`.
 *
 *   Bug 2 — `rebuildCheckpointHistory` is a re-derivation, not a repair.
 *           It copies each per-doc `chain_hash` straight off disk
 *           (checkpoint.ts:349) WITHOUT validating the per-doc chain, and emits
 *           one checkpoint per (doc, version) tuple with different semantics
 *           than the live path (at = published_at, triggered_by = docId). So a
 *           tampered per-doc chain survives the rebuild and is even laundered
 *           into a checkpoint chain that then verifies "clean" — no convergence
 *           toward a correct state.
 *
 * These tests are written to FAIL against the current (buggy) engine and pass
 * once the publish path is serialized / re-reads heads before sealing (Bug 1)
 * and the rebuild validates chains before re-sealing (Bug 2).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { CheckpointManager } from "../checkpoint.js";
import { verifyCheckpointChain } from "../integrity.js";
import { isPublished } from "../parser.js";

async function writeDraft(
  storage: NestStorage,
  docId: string,
  title: string,
  body: string,
): Promise<void> {
  const content =
    `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n${body}\n`;
  await storage.writeDocument(docId, content);
}

describe("Bug 1 — non-atomic checkpoint seal points at a superseded chain_hash", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cpbug1-"));
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seals document_versions and document_chain_hashes from two-phase reads (deterministic)", async () => {
    const docId = "nodes/race-doc";
    await writeDraft(storage, docId, "Race Doc", "v1 body");

    // First publish — doc head is now at v1.
    await publishDocument(storage, docId, { editedBy: "alice" });

    // Phase A of the next publish: read the per-doc history snapshot
    // (publish.ts:95). At this instant the head is still v1.
    const stalePhaseAHistories = await storage.findAllHistories();

    // A concurrent/interleaved publish advances the head to v2 on disk.
    await publishDocument(storage, docId, { editedBy: "bob" });

    // Phase B: read the published-doc snapshot (publish.ts:91). It now sees v2.
    const freshPhaseBDocs = (await storage.discoverDocuments()).filter(isPublished);

    // Seal a checkpoint from the mismatched two-phase state — exactly what the
    // unlocked publish path does when a publish interleaves between its reads.
    const cm = new CheckpointManager(storage);
    await cm.createCheckpoint(docId, freshPhaseBDocs, stalePhaseAHistories);

    // The sealed checkpoint claims version 2 but carries v1's chain_hash.
    const cpHistory = await cm.loadCheckpointHistory();
    const poisoned = cpHistory!.checkpoints.at(-1)!;
    expect(poisoned.document_versions[docId]).toBe(2);

    const liveHistories = await storage.findAllHistories();
    const v2ChainHash = liveHistories
      .get(docId)!
      .versions.find((v) => v.version === 2)!.chain_hash;
    // Ground truth: the checkpoint's sealed hash does NOT match the doc's real
    // chain_hash at the version it claims.
    expect(poisoned.document_chain_hashes[docId]).not.toBe(v2ChainHash);

    // And verification catches it.
    const report = verifyCheckpointChain(cpHistory!.checkpoints, liveHistories);
    const mismatches = report.errors.filter(
      (e) => e.type === "cross_chain_mismatch",
    );
    expect(mismatches.length).toBeGreaterThan(0);
  });
});

describe("Bug 2 — rebuildCheckpointHistory re-derives instead of repairing", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cpbug2-"));
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produces a different checkpoint chain than the live path (re-derivation, not repair)", async () => {
    await writeDraft(storage, "nodes/doc-a", "Doc A", "a1");
    await publishDocument(storage, "nodes/doc-a", { editedBy: "alice" });
    await writeDraft(storage, "nodes/doc-b", "Doc B", "b1");
    await publishDocument(storage, "nodes/doc-b", { editedBy: "bob" });

    const cm = new CheckpointManager(storage);
    const live = (await cm.loadCheckpointHistory())!;
    const liveHashes = live.checkpoints.map((c) => c.checkpoint_hash);

    // The live path stamps each checkpoint with a wall-clock `at` that is
    // strictly later than the version's published_at.
    for (const cp of live.checkpoints) {
      const publishedAt = (await storage.readHistory(cp.triggered_by))!.versions
        .at(-1)!.published_at;
      expect(cp.at).not.toBe(publishedAt);
    }

    const rebuilt = await cm.rebuildCheckpointHistory();
    const rebuiltHashes = rebuilt.checkpoints.map((c) => c.checkpoint_hash);

    // Rebuild re-stamps `at` with the doc's published_at instead...
    for (const cp of rebuilt.checkpoints) {
      const publishedAt = (await storage.readHistory(cp.triggered_by))!.versions
        .at(-1)!.published_at;
      expect(cp.at).toBe(publishedAt);
    }

    // ...so the rebuilt checkpoint_hash chain does NOT match the live one it
    // claims to reconstruct — it is a fresh derivation, not a faithful rebuild.
    expect(rebuiltHashes).not.toEqual(liveHashes);
  });

  it("does not launder a tampered per-doc chain through rebuild (recomputes + surfaces it)", async () => {
    const docId = "nodes/audited";
    await writeDraft(storage, docId, "Audited", "v1");
    await publishDocument(storage, docId, { editedBy: "alice" }); // v1
    await publishDocument(storage, docId, { editedBy: "alice" }); // v2

    const cm = new CheckpointManager(storage);

    // Tamper the per-doc chain on disk: rewrite the head version's chain_hash.
    const tampered = "sha256:" + "de".repeat(32);
    const history = (await storage.readHistory(docId))!;
    history.versions.at(-1)!.chain_hash = tampered;
    await storage.writeHistory(docId, history);

    // BEFORE rebuild: the live checkpoint (sealed with the real hash) no longer
    // matches the tampered chain — verification correctly reports the tamper.
    const beforeHistories = await storage.findAllHistories();
    const liveCp = (await cm.loadCheckpointHistory())!;
    const before = verifyCheckpointChain(liveCp.checkpoints, beforeHistories);
    expect(
      before.errors.some((e) => e.type === "cross_chain_mismatch"),
    ).toBe(true);

    // Rebuild recomputes each version's chain hash instead of copying the
    // stored (tampered) value, so the tampered hash is never re-sealed.
    const rebuilt = await cm.rebuildCheckpointHistory();
    const rebuiltHead = rebuilt.checkpoints.at(-1)!;
    expect(rebuiltHead.document_chain_hashes[docId]).not.toBe(tampered);

    // ...and because the on-disk history is still tampered, the rebuilt chain
    // surfaces the mismatch rather than blessing it — a real repair, not a
    // re-derivation that launders the corruption.
    const afterHistories = await storage.findAllHistories();
    const after = verifyCheckpointChain(rebuilt.checkpoints, afterHistories);
    expect(
      after.errors.some((e) => e.type === "cross_chain_mismatch"),
    ).toBe(true);
  });
});
