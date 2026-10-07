/**
 * Document publish orchestration.
 * Ties together versioning, integrity, checkpoints, and index regeneration.
 */

import { join } from "node:path";
import type {
  Checkpoint,
  ClientMetadata,
  ContextNode,
  Frontmatter,
  VersionEntry,
} from "./types.js";
import { NestStorage, assertWritableDocumentId } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { serializeDocument, getChecksumContent, isRejected, parseDocument } from "./parser.js";
import { computeContentHash } from "./integrity.js";
import { RejectedDocumentError } from "./errors.js";
import { mapInBatches } from "./concurrency.js";
import { assertPdfSidecarIntact } from "./pdf-nodes.js";
import { assertNotForgotten } from "./forget.js";
import { assertStructurePublish, enforcedStructure, scaffoldFirstPublish } from "./structure-store.js";

export interface PublishOptions {
  editedBy: string;
  note?: string;
  /**
   * Caller metadata recorded on the version entry this publish seals (§9.4) —
   * which agent, in which session. Not hashed; see `VersionEntry.client`.
   */
  client?: ClientMetadata;
  /**
   * `skip` leaves structure rules (§11.1.1) unchecked — for trusted hosts
   * restoring a whole vault only, as `OperationContext.structure`. The
   * reserved-path guard still applies.
   */
  structure?: "skip";
}

export interface PublishResult {
  node: ContextNode;
  versionEntry: VersionEntry;
  checkpointNumber: number;
  /** The checkpoint this publish sealed — hand it to regenerateIndex. */
  checkpoint: Checkpoint;
  /**
   * The vault crawl the checkpoint took after the write — hand it to
   * regenerateIndex as `docs`. Like `checkpoint`, only valid passed straight
   * through under the same lock: any write in between makes it stale.
   */
  vaultDocs: ContextNode[];
}

/**
 * Publish a document: bump version, compute checksum, create version entry,
 * create checkpoint, and regenerate context.yaml.
 */
export async function publishDocument(
  storage: NestStorage,
  docId: string,
  options: PublishOptions,
): Promise<PublishResult> {
  // Every publish surface (context_publish, ids[] imports, approvals, legacy
  // tools) ends here, so a reserved path is refused once, for all of them.
  assertWritableDocumentId(docId);
  // Read current document
  let node = await storage.readDocument(docId);

  // Guard against silent resurrection: republishing a rejected node would
  // flip its status to "published" and put it back into retrieval. Callers
  // (e.g. importers running publishDocument on every discovered file) must
  // either skip rejected docs or change their status first.
  if (isRejected(node)) {
    throw new RejectedDocumentError(docId);
  }
  // Same guard for the forget protocol (§6.3.4): a forgotten stub, a path a
  // forget retired, or content matching erased content.
  await assertNotForgotten(storage, node);
  // A pdf node seals pdf.sha256 into the chain; the bytes must be there.
  await assertPdfSidecarIntact(storage, docId, node);
  const rules = options.structure === "skip" ? null : await enforcedStructure(storage);

  const versionManager = new VersionManager(storage);

  // Seed pre-publish snapshot when a doc carries an existing
  // frontmatter.version (>1) but has no recorded history yet. Without this,
  // its pre-publish body becomes permanently unreachable via read_version
  // once we bump to the next number.
  //
  // Resilient read: an unreadable history.yaml no longer refuses the publish.
  // It is preserved under `.corrupt-<ts>.yaml` and the chain restarts here —
  // numbering still clears every artifact on disk, so nothing is overwritten.
  //
  // The seed is skipped on that restart path. It exists to rescue a body that
  // has no artifact; after a quarantine every artifact is still on disk, and
  // seeding would write `v{current}.md` at a number the old chain may already
  // have sealed as a keyframe — an exclusive create that throws, which would
  // put the author right back behind the corrupt file we just worked around.
  // Every publish surface ends here, so the structure rules judge it here —
  // before historyOrRepair, so a refused publish never quarantines a history.
  const firstPublish = rules ? await assertStructurePublish(storage, rules, node) : false;
  const { history: existingHistory, quarantinedAs } =
    await versionManager.historyOrRepair(docId);
  const seeded = !existingHistory && !quarantinedAs && (node.frontmatter.version || 0) > 1;
  if (seeded) {
    await versionManager.createVersion(node, "system:seed", {
      note: "Pre-publish snapshot (auto-seeded — no prior history)",
      knownHistory: null,
    });
  }
  // The history read above, reused below instead of re-read; a seed just
  // appended to it, so then it is read fresh.
  const knownHistory = seeded ? undefined : existingHistory;

  // Bump version — past the recorded history too, not just frontmatter, so a
  // doc whose frontmatter lags its history.yaml (imported/copied vault) cannot
  // reuse a version number and graft a second chain onto the first.
  const newVersion = await versionManager.nextVersion(
    docId,
    node.frontmatter.version || 0,
    knownHistory,
  );
  node.frontmatter.version = newVersion;
  node.frontmatter.status = "published";
  node.frontmatter.updated_at = new Date().toISOString();

  // Compute document body checksum
  const serialized = serializeDocument(node);
  node.frontmatter.checksum = computeContentHash(getChecksumContent(serialized));

  // Re-serialize with updated frontmatter
  const finalContent = serializeDocument(node);
  node.rawContent = finalContent;
  node.body = finalContent.slice(
    finalContent.indexOf("---", finalContent.indexOf("---") + 3) + 3,
  );

  // Write updated document to disk
  await storage.writeDocument(docId, finalContent);

  // Clean parse of exactly what was written — no read back from disk.
  node = parseWritten(storage, docId, finalContent);

  const publishedAt = new Date().toISOString();

  // Create version entry with integrity hashes
  const versionEntry = await versionManager.createVersion(node, options.editedBy, {
    note: options.note,
    publishedAt,
    client: options.client,
    knownHistory,
  });
  // Before the checkpoint, so the vault crawl it hands back includes them.
  if (rules && firstPublish) await scaffoldFirstPublish(storage, rules, [docId]);

  // Create checkpoint. The published-docs and histories snapshots are gathered
  // INSIDE the checkpoint lock (createCheckpointFromVault) so a concurrent
  // publish cannot slip between two separate reads and leave a doc missing from
  // — or version-skewed within — the checkpoint this publish seals.
  const checkpointManager = new CheckpointManager(storage);
  let vaultDocs: ContextNode[] = [];
  const checkpoint = await checkpointManager.createCheckpointFromVault(
    docId,
    new Map([[docId, versionEntry]]),
    (docs) => (vaultDocs = docs),
  );

  return {
    node,
    versionEntry,
    checkpointNumber: checkpoint.checkpoint,
    checkpoint,
    vaultDocs,
  };
}

/** Parse a document from the plaintext just written, as readDocument would. */
function parseWritten(storage: NestStorage, docId: string, content: string): ContextNode {
  return parseDocument(join(storage.root, `${docId}.md`), content, docId);
}

// ─── Bulk publish (importers) ────────────────────────────────────────────────

export interface BulkPublishOptions extends PublishOptions {
  /** Max documents published concurrently (default 16). Per-doc work touches
   * only that doc's own files, so distinct ids are independent. */
  concurrency?: number;
  /** Regenerate context.yaml / INDEX.md once after the batch (default true). */
  regenerateIndex?: boolean;
  /**
   * Rewrite INDEX.md only for the folders of the batch's documents. Only safe
   * when nothing else in the vault changed in the same operation.
   */
  indexOnlyBatchFolders?: boolean;
  /** Fires once per document as it settles, published or failed. Advisory: with
   * concurrency > 1 docs finish out of input order, so only the count is
   * monotonic — it drives progress bars, not per-doc reporting. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Frontmatter to merge into each document just before it is published.
   *
   * For importers that must stamp their own metadata (an `author` that is the
   * importing user, a `title` fallback from the filename) onto every incoming
   * file. Doing it here folds the stamp into the publish write; a caller doing
   * it beforehand pays a SECOND full write pass over the vault, which on a
   * network-backed mount is one extra round trip per document.
   *
   * Returning `null`/`undefined` leaves the document's frontmatter alone. The
   * publish fields (`version`, `status`, `updated_at`, `checksum`) are applied
   * after this and always win.
   */
  frontmatter?: (node: ContextNode) => Partial<Frontmatter> | null | undefined;
}

export interface BulkPublishResult {
  published: { id: string; version: number; chainHash: string }[];
  /** Docs that failed (bad frontmatter, rejected, validation) — batch never aborts. */
  failed: { id: string; error: string }[];
  /** The single checkpoint sealing every published doc, or null if none published. */
  checkpointNumber: number | null;
}

/**
 * Bulk-publish MANY documents in one pass — for importers ingesting a whole
 * nest folder (500+ files). Publishing one-by-one via `publishDocument` is
 * O(N²): each call seals its own checkpoint, and every checkpoint re-scans the
 * ENTIRE vault (discoverDocuments + findAllHistories + rewrite of the growing
 * context_history.yaml). This function does the per-doc version work N times
 * but seals ONE checkpoint for the whole batch and regenerates the index ONCE
 * — collapsing N full-vault rescans into a single pass (O(N)).
 *
 * Failure-isolated: a bad file is recorded in `failed` and skipped; the rest
 * still publish and the single checkpoint seals the successful ones.
 *
 * NOTE: the per-doc body below intentionally mirrors `publishDocument` (minus
 * the checkpoint) so the existing single-publish path stays untouched. Keep the
 * two in sync if the publish steps change.
 */
export async function publishDocuments(
  storage: NestStorage,
  docIds: string[],
  options: BulkPublishOptions,
): Promise<BulkPublishResult> {
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const published: BulkPublishResult["published"] = [];
  const failed: BulkPublishResult["failed"] = [];
  let settled = 0;

  // Vet the batch before publishing anything. Ids reach here straight from
  // callers (MCP tool arguments, CLI flags), and the per-doc work joins them
  // onto the vault root verbatim — a `..` segment would read and OVERWRITE a
  // file outside the vault. A duplicate is unsafe too: two publishOne calls in
  // one concurrency window race the same history.yaml, and the losing write
  // disappears while still being reported as published.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const docId of docIds) {
    if (seen.has(docId)) continue;
    seen.add(docId);
    try {
      assertWritableDocumentId(docId);
      ids.push(docId);
    } catch (err) {
      failed.push({ id: docId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // One read of the forget registry, and of the structure rules, for the whole batch.
  const tombstones = await storage.readTombstones();
  const rules = options.structure === "skip" ? null : await enforcedStructure(storage);
  const firstPublished: string[] = [];

  const publishOne = async (docId: string): Promise<void> => {
    try {
      let node = await storage.readDocument(docId);
      if (isRejected(node)) throw new RejectedDocumentError(docId);
      await assertNotForgotten(storage, node, tombstones);
      await assertPdfSidecarIntact(storage, docId, node);

      // Importer metadata rides along with the publish write below rather than
      // costing its own pass over the vault. Applied before the version bump so
      // the publish fields still win.
      const stamp = options.frontmatter?.(node);
      if (stamp) node = { ...node, frontmatter: { ...node.frontmatter, ...stamp } };

      const versionManager = new VersionManager(storage);
      // Same resilient read, the same seed skip on a restart, and the same
      // single history read — see the notes in publishDocument.
      // Judged before historyOrRepair: a refused publish quarantines nothing.
      const firstPublish = rules ? await assertStructurePublish(storage, rules, node) : false;
      const { history: existingHistory, quarantinedAs } =
        await versionManager.historyOrRepair(docId);
      const seeded = !existingHistory && !quarantinedAs && (node.frontmatter.version || 0) > 1;
      if (seeded) {
        await versionManager.createVersion(node, "system:seed", {
          note: "Pre-publish snapshot (auto-seeded — no prior history)",
          knownHistory: null,
        });
      }
      const knownHistory = seeded ? undefined : existingHistory;

      const newVersion = await versionManager.nextVersion(
        docId,
        node.frontmatter.version || 0,
        knownHistory,
      );
      node.frontmatter.version = newVersion;
      node.frontmatter.status = "published";
      node.frontmatter.updated_at = new Date().toISOString();

      const serialized = serializeDocument(node);
      node.frontmatter.checksum = computeContentHash(getChecksumContent(serialized));
      const finalContent = serializeDocument(node);
      await storage.writeDocument(docId, finalContent);

      node = parseWritten(storage, docId, finalContent);
      const versionEntry = await versionManager.createVersion(node, options.editedBy, {
        note: options.note,
        publishedAt: new Date().toISOString(),
        client: options.client,
        knownHistory,
      });
      published.push({
        id: docId,
        version: versionEntry.version,
        chainHash: versionEntry.chain_hash,
      });
      if (firstPublish) firstPublished.push(docId);
    } catch (err) {
      failed.push({ id: docId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      // Counter increments are safe unsynchronized — JS runs them on one thread;
      // only the awaited I/O above overlaps.
      options.onProgress?.(++settled, ids.length);
    }
  };

  // Bounded-concurrency pass — no cross-doc dependency, so batching is enough
  // (the shared helper avoids pulling in a p-limit dependency). publishOne
  // records its own outcome, so the returned array is unused.
  await mapInBatches(ids, publishOne, concurrency);
  // Before the checkpoint, so the vault crawl it takes includes them.
  if (rules && firstPublished.length > 0) await scaffoldFirstPublish(storage, rules, firstPublished);

  // ONE checkpoint sealing every doc published above (createCheckpointFromVault
  // snapshots all published docs in the vault under the checkpoint lock).
  let checkpoint: Checkpoint | undefined;
  let vaultDocs: ContextNode[] | undefined;
  if (published.length > 0) {
    checkpoint = await new CheckpointManager(storage).createCheckpointFromVault(
      `bulk-import (${published.length} docs)`,
      new Map(published.map((p) => [p.id, { version: p.version, chain_hash: p.chainHash }])),
      (docs) => (vaultDocs = docs),
    );
  }

  // ONE index regen for the whole batch (skippable by callers that regen later).
  if (options.regenerateIndex !== false) {
    await storage.regenerateIndex({
      ...(options.indexOnlyBatchFolders ? { changedIds: ids } : {}),
      ...(checkpoint ? { latestCheckpoint: checkpoint } : {}),
      ...(vaultDocs ? { docs: vaultDocs } : {}),
    });
  }
  const checkpointNumber = checkpoint?.checkpoint ?? null;

  return { published, failed, checkpointNumber };
}
