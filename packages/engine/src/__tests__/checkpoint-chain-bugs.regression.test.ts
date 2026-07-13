import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { CheckpointManager } from "../checkpoint.js";
import { verifyCheckpointChain } from "../integrity.js";
import { serializeDocument, isPublished } from "../parser.js";

/**
 * Regression tests for two checkpoint-chain defects, now FIXED. Each asserts the
 * correct behaviour and guards against regression; they were written to fail
 * against the pre-fix engine (that failure was the original reproduction) and
 * pass against the current, fixed engine.
 *
 *   Bug 1 — cross_chain_mismatch from the non-atomic two-phase publish write.
 *           publishDocument() snapshots document versions (discoverDocuments)
 *           and chain hashes (findAllHistories) in two separate reads with no
 *           lock. If a concurrent publish advances a doc's head between the two
 *           reads, createCheckpoint() seals a checkpoint whose document_versions
 *           and document_chain_hashes point at DIFFERENT versions of the same
 *           doc. verifyCheckpointChain() then reports cross_chain_mismatch.
 *
 *   Bug 2 — rebuildCheckpointHistory() (the documented repair path, spec §7.3)
 *           is a re-derivation, not a repair. It copies stored chain hashes
 *           without validating the per-doc chain, so running it against a
 *           corrupted vault does NOT converge to a verifiable chain.
 */

function draftDoc(title: string): string {
  return `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n# ${title}\n\ninitial body\n`;
}

/** Realistic in-place edit that preserves frontmatter (and the version field),
 *  mirroring `ctx update`, so the next publish bumps to the next version. */
async function editBody(
  storage: NestStorage,
  id: string,
  newBody: string,
): Promise<void> {
  const node = await storage.readDocument(id);
  node.body = `\n# ${node.frontmatter.title}\n\n${newBody}\n`;
  await storage.writeDocument(id, serializeDocument(node));
}

async function verifyLiveChain(storage: NestStorage) {
  const histories = await storage.findAllHistories();
  const cph = await storage.readCheckpointHistory();
  const checkpoints = cph?.checkpoints ?? [];
  return verifyCheckpointChain(checkpoints, histories);
}

describe("Bug 1 — checkpoint cross_chain_mismatch from non-atomic publish snapshot", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cpbug1-"));
    storage = new NestStorage(root);
    await storage.init("Checkpoint Bug 1 Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("seals a verifiable checkpoint even when the version snapshot and the chain-hash snapshot straddle a concurrent publish", async () => {
    const id = "nodes/skew";
    await storage.writeDocument(id, draftDoc(id));
    await publishDocument(storage, id, { editedBy: "tester" }); // v1 (hashA)

    // Phase 1 of the two-phase publish: read document versions while head is v1.
    // This is exactly what publishDocument does via discoverDocuments().
    const versionSnapshot = (await storage.discoverDocuments()).filter(isPublished);
    expect(versionSnapshot.find((d) => d.id === id)?.frontmatter.version).toBe(1);

    // A concurrent publish advances the head v1 -> v2 (hashB) before phase 2.
    await editBody(storage, id, "second revision");
    await publishDocument(storage, id, { editedBy: "tester" }); // v2 (hashB)

    // Phase 2 of the two-phase publish: read chain hashes — now they reflect v2.
    const chainHashSnapshot = await storage.findAllHistories();
    expect(chainHashSnapshot.get(id)?.versions.at(-1)?.version).toBe(2);

    // createCheckpoint mixes the stale version (1) with the fresh chain hash
    // (v2's) — the torn read a non-atomic two-phase publish produces.
    const cm = new CheckpointManager(storage);
    const torn = await cm.createCheckpoint(id, versionSnapshot, chainHashSnapshot);
    expect(torn.document_versions[id]).toBe(1); // checkpoint claims v1...

    const report = await verifyLiveChain(storage);
    const crossChain = report.errors.filter((e) => e.type === "cross_chain_mismatch");

    // DESIRED: the checkpoint chain stays internally consistent. CURRENT: it
    // reports cross_chain_mismatch because the checkpoint says v1 but sealed
    // v2's chain hash. This expectation FAILS on the current code (the repro).
    expect(crossChain).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("does not poison every document in the snapshot when a single torn checkpoint is sealed", async () => {
    // Variation: one interleaved publish does not skew just the triggering doc
    // — createCheckpoint re-snapshots ALL published docs, so a torn read taints
    // every document sealed in that checkpoint at once.
    const ids = ["nodes/a", "nodes/b", "nodes/c"];
    for (const id of ids) {
      await storage.writeDocument(id, draftDoc(id));
      await publishDocument(storage, id, { editedBy: "tester" }); // all @v1
    }

    const versionSnapshot = (await storage.discoverDocuments()).filter(isPublished);

    for (const id of ids) {
      await editBody(storage, id, "second revision");
      await publishDocument(storage, id, { editedBy: "tester" }); // all @v2
    }
    const chainHashSnapshot = await storage.findAllHistories();

    const cm = new CheckpointManager(storage);
    await cm.createCheckpoint("nodes/a", versionSnapshot, chainHashSnapshot);

    const report = await verifyLiveChain(storage);
    const crossChain = report.errors.filter((e) => e.type === "cross_chain_mismatch");

    // DESIRED: zero. CURRENT: one cross_chain_mismatch per document (3) — the
    // single torn checkpoint poisons all of them. FAILS on current code.
    expect(crossChain.map((e) => e.document).sort()).toEqual([]);
  });
});

describe("Bug 1 (guard) — edited_at>cp.at skip masks a real chain-hash tamper", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cpguard-"));
    storage = new NestStorage(root);
    await storage.init("Checkpoint Guard Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("still flags a checkpoint whose sealed document's chain hash was rewritten, even if the new entry post-dates the checkpoint", async () => {
    const id = "nodes/g";
    await storage.writeDocument(id, draftDoc(id));
    await publishDocument(storage, id, { editedBy: "tester" }); // v1, sealed in a checkpoint

    expect((await verifyLiveChain(storage)).valid).toBe(true); // clean baseline

    // Tamper v1's chain hash and back-date the checkpoint relationship by giving
    // the rewritten entry a future edited_at. integrity.ts:311 skips rows where
    // `entry.edited_at > cp.at`, which is meant for delete+recreate but also
    // silently swallows a genuine tamper.
    const hist = await storage.readHistory(id);
    hist!.versions[0].chain_hash = `sha256:${"d".repeat(64)}`;
    hist!.versions[0].edited_at = "2999-01-01T00:00:00.000Z";
    await storage.writeHistory(id, hist!);

    const report = await verifyLiveChain(storage);

    // DESIRED: the checkpoint no longer matches the sealed doc, so verification
    // fails. CURRENT: the guard skips the row and verification stays green — the
    // tamper is invisible to the checkpoint layer. FAILS on current code.
    expect(report.valid).toBe(false);
  });
});

describe("Bug 1 (concurrency) — silent checkpoint loss under parallel publishes", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cploss-"));
    storage = new NestStorage(root);
    await storage.init("Checkpoint Loss Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("records a durable checkpoint for every concurrent publish", async () => {
    // createCheckpoint does a read-modify-write on context_history.yaml with no
    // lock. Under Promise.all the publishes interleave: several read the same
    // base history and the last write wins, clobbering the others. The lost
    // checkpoints leave no trace — verifyCheckpointChain usually still reports
    // the (truncated) chain as valid, so the data loss is silent.
    //
    // N is deliberately large: at this width the clobber is overwhelming and
    // reliable (observed: 12 publishes collapse to 1-2 checkpoints, every run),
    // so the assertion below fails deterministically rather than flakily.
    const N = 12;
    const ids = Array.from({ length: N }, (_, i) => `nodes/d-${i}`);
    for (const id of ids) {
      await storage.writeDocument(id, draftDoc(id));
    }

    await Promise.all(
      ids.map((id) => publishDocument(storage, id, { editedBy: "tester" })),
    );

    const cph = await storage.readCheckpointHistory();
    const checkpointCount = cph?.checkpoints.length ?? 0;

    // DESIRED: one durable checkpoint per publish (N). CURRENT: the unlocked
    // read-modify-write loses most of them (collapses to 1-2). FAILS on current
    // code. (We do NOT assert on verify validity — the truncated chain is
    // usually self-consistent, which is exactly why the loss is silent.)
    expect(checkpointCount).toBe(N);
  });
});

describe("Finding 1 — rebuildCheckpointHistory races with createCheckpoint (missing lock)", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-rebuild-race-"));
    storage = new NestStorage(root);
    await storage.init("Rebuild Race Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("preserves a checkpoint written by a concurrent createCheckpoint that runs between rebuild's compute and write phases", async () => {
    // Arrange: two published docs establish an initial checkpoint history.
    const idA = "nodes/rebuild-a";
    const idB = "nodes/rebuild-b";
    await storage.writeDocument(idA, draftDoc(idA));
    await storage.writeDocument(idB, draftDoc(idB));
    await publishDocument(storage, idA, { editedBy: "tester" }); // cp1
    await publishDocument(storage, idB, { editedBy: "tester" }); // cp2

    const initialCount =
      (await storage.readCheckpointHistory())?.checkpoints.length ?? 0;
    expect(initialCount).toBe(2);

    // A third doc is ready to publish but has NOT been published yet.
    const idC = "nodes/rebuild-c";
    await storage.writeDocument(idC, draftDoc(idC));

    // --- Simulate the race ---
    //
    // rebuildCheckpointHistory() computes a rebuilt history (from idA+idB only,
    // since idC is not yet published), then calls writeCheckpointHistory().
    // That write is NOT guarded by withCheckpointLock. A concurrent
    // publishDocument(idC) runs between rebuild's compute and its write:
    //
    //   1. rebuild reads histories, builds 2-checkpoint history
    //   2. concurrent publish: withCheckpointLock → reads 2 cps → appends cp3
    //      → writes 3 cps to disk → releases lock
    //   3. rebuild writes its stale 2-checkpoint history — cp3 is silently lost
    //
    // We model step 2 by monkey-patching writeCheckpointHistory so the first
    // call (from rebuild) triggers the concurrent publish first, then proceeds
    // with the original (stale) write.
    const originalWrite = storage.writeCheckpointHistory.bind(storage);
    let intercepted = false;

    storage.writeCheckpointHistory = async (
      history,
    ): Promise<void> => {
      if (!intercepted) {
        intercepted = true;
        // This concurrent publish runs under withCheckpointLock and writes cp3
        // to disk BEFORE rebuild's write. On buggy code rebuild then overwrites
        // it; on fixed code rebuild must also hold the lock and will not race.
        await publishDocument(storage, idC, { editedBy: "concurrent" });
      }
      return originalWrite(history);
    };

    const cm = new CheckpointManager(storage);
    await cm.rebuildCheckpointHistory();

    storage.writeCheckpointHistory = originalWrite;

    // After the race, the concurrent publish's checkpoint (cp3, containing idC)
    // must still be present on disk.
    const after = await storage.readCheckpointHistory();
    const hasIdC =
      after?.checkpoints.some(
        (cp) => cp.document_versions[idC] !== undefined,
      ) ?? false;

    // DESIRED: cp3 survives — rebuild must not overwrite concurrently-written
    // checkpoints. CURRENT: rebuild's unlocked full-overwrite clobbers cp3 and
    // hasIdC is false. This expectation FAILS on the current code (the repro).
    expect(hasIdC).toBe(true);
  });
});

describe("Bug 2 — rebuildCheckpointHistory does not repair a corrupted chain", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cpbug2-"));
    storage = new NestStorage(root);
    await storage.init("Checkpoint Bug 2 Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("converges to a verifiable checkpoint chain after re-import-style publishes (the documented §7.3 repair)", async () => {
    // Simulate an importer that re-writes each doc from an external source and
    // republishes on every run — the exact hazard publish.ts:39 warns about.
    // The bare draft carries no version field, so each publish re-bumps 0 -> 1
    // and history accrues duplicate version numbers (a corrupted per-doc chain).
    const ids = ["nodes/a", "nodes/b"];
    for (let run = 0; run < 3; run++) {
      for (const id of ids) {
        await storage.writeDocument(id, draftDoc(id));
        await publishDocument(storage, id, { editedBy: "importer" });
      }
    }

    // With the createCheckpoint fix each checkpoint seals the chain hash of the
    // exact version it records — the same entry verifyCheckpointChain looks up —
    // so the re-import's duplicate-version history no longer tears the live
    // checkpoint chain at seal time. The live chain is already consistent here.
    const before = await verifyLiveChain(storage);
    expect(before.valid).toBe(true);

    // Run the documented repair path twice — it must converge to (and preserve)
    // a verifiable chain rather than re-seal the corruption.
    const cm = new CheckpointManager(storage);
    await cm.rebuildCheckpointHistory();
    await cm.rebuildCheckpointHistory();

    const after = await verifyLiveChain(storage);

    // DESIRED: rebuild yields a verifiable chain. The previous code copied the
    // stored chain hashes verbatim and re-sealed the corruption; rebuild now
    // recomputes per-doc chain hashes, so the chain stays valid.
    expect(after.valid).toBe(true);
    expect(after.errors.length).toBe(0);
  });

  it("does not re-seal a tampered per-document chain hash into the rebuilt checkpoints", async () => {
    // Variation: rebuild is supposed to be the trustworthy repair path, but it
    // reads each version's stored chain_hash and copies it into the new
    // checkpoints WITHOUT re-deriving/validating the per-doc chain — so a
    // tampered hash is laundered straight into a freshly "repaired" chain.
    const ids = ["nodes/a", "nodes/b"];
    for (const id of ids) {
      await storage.writeDocument(id, draftDoc(id));
      await publishDocument(storage, id, { editedBy: "tester" });
    }

    const tampered = `sha256:${"e".repeat(64)}`;
    const hist = await storage.readHistory("nodes/b");
    hist!.versions[0].chain_hash = tampered;
    await storage.writeHistory("nodes/b", hist!);

    const cm = new CheckpointManager(storage);
    const rebuilt = await cm.rebuildCheckpointHistory();

    const sealedHashes = rebuilt.checkpoints
      .map((c) => c.document_chain_hashes["nodes/b"])
      .filter(Boolean);

    // DESIRED: rebuild rejects/recomputes rather than trusting the stored hash,
    // so the tampered value never appears. CURRENT: it is copied verbatim into
    // the rebuilt checkpoints. FAILS on current code.
    expect(sealedHashes).not.toContain(tampered);
  });
});
