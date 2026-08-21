/**
 * Document publish orchestration.
 * Ties together versioning, integrity, checkpoints, and index regeneration.
 */

import type {
  ClientMetadata,
  ContextNode,
  Frontmatter,
  VersionEntry,
} from "./types.js";
import { NestStorage, assertSafeDocumentId } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { serializeDocument, getChecksumContent, isRejected } from "./parser.js";
import { computeContentHash } from "./integrity.js";
import { RejectedDocumentError } from "./errors.js";
import { mapInBatches } from "./concurrency.js";

export interface PublishOptions {
  editedBy: string;
  note?: string;
  /**
   * Caller metadata recorded on the version entry this publish seals (§9.4) —
   * which agent, in which session. Not hashed; see `VersionEntry.client`.
   */
  client?: ClientMetadata;
}

export interface PublishResult {
  node: ContextNode;
  versionEntry: VersionEntry;
  checkpointNumber: number;
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
  // Read current document
  let node = await storage.readDocument(docId);

  // Guard against silent resurrection: republishing a rejected node would
  // flip its status to "published" and put it back into retrieval. Callers
  // (e.g. importers running publishDocument on every discovered file) must
  // either skip rejected docs or change their status first.
  if (isRejected(node)) {
    throw new RejectedDocumentError(docId);
  }

  const versionManager = new VersionManager(storage);

  // Seed pre-publish snapshot when a doc carries an existing
  // frontmatter.version (>1) but has no recorded history yet. Without this,
  // its pre-publish body becomes permanently unreachable via read_version
  // once we bump to the next number.
  const existingHistory = await storage.readHistory(docId);
  if (!existingHistory && (node.frontmatter.version || 0) > 1) {
    await versionManager.createVersion(node, "system:seed", {
      note: "Pre-publish snapshot (auto-seeded — no prior history)",
    });
  }

  // Bump version — past the recorded history too, not just frontmatter, so a
  // doc whose frontmatter lags its history.yaml (imported/copied vault) cannot
  // reuse a version number and graft a second chain onto the first.
  const newVersion = await versionManager.nextVersion(
    docId,
    node.frontmatter.version || 0,
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

  // Re-read to get clean parse
  node = await storage.readDocument(docId);

  const publishedAt = new Date().toISOString();

  // Create version entry with integrity hashes
  const versionEntry = await versionManager.createVersion(node, options.editedBy, {
    note: options.note,
    publishedAt,
    client: options.client,
  });

  // Create checkpoint. The published-docs and histories snapshots are gathered
  // INSIDE the checkpoint lock (createCheckpointFromVault) so a concurrent
  // publish cannot slip between two separate reads and leave a doc missing from
  // — or version-skewed within — the checkpoint this publish seals.
  const checkpointManager = new CheckpointManager(storage);
  const checkpoint = await checkpointManager.createCheckpointFromVault(docId);

  return {
    node,
    versionEntry,
    checkpointNumber: checkpoint.checkpoint,
  };
}

// ─── Bulk publish (importers) ────────────────────────────────────────────────

export interface BulkPublishOptions extends PublishOptions {
  /** Max documents published concurrently (default 16). Per-doc work touches
   * only that doc's own files, so distinct ids are independent. */
  concurrency?: number;
  /** Regenerate context.yaml / INDEX.md once after the batch (default true). */
  regenerateIndex?: boolean;
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
      assertSafeDocumentId(docId);
      ids.push(docId);
    } catch (err) {
      failed.push({ id: docId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const publishOne = async (docId: string): Promise<void> => {
    try {
      let node = await storage.readDocument(docId);
      if (isRejected(node)) throw new RejectedDocumentError(docId);

      // Importer metadata rides along with the publish write below rather than
      // costing its own pass over the vault. Applied before the version bump so
      // the publish fields still win.
      const stamp = options.frontmatter?.(node);
      if (stamp) node = { ...node, frontmatter: { ...node.frontmatter, ...stamp } };

      const versionManager = new VersionManager(storage);
      const existingHistory = await storage.readHistory(docId);
      if (!existingHistory && (node.frontmatter.version || 0) > 1) {
        await versionManager.createVersion(node, "system:seed", {
          note: "Pre-publish snapshot (auto-seeded — no prior history)",
        });
      }

      const newVersion = await versionManager.nextVersion(
        docId,
        node.frontmatter.version || 0,
      );
      node.frontmatter.version = newVersion;
      node.frontmatter.status = "published";
      node.frontmatter.updated_at = new Date().toISOString();

      const serialized = serializeDocument(node);
      node.frontmatter.checksum = computeContentHash(getChecksumContent(serialized));
      const finalContent = serializeDocument(node);
      await storage.writeDocument(docId, finalContent);

      node = await storage.readDocument(docId);
      const versionEntry = await versionManager.createVersion(node, options.editedBy, {
        note: options.note,
        publishedAt: new Date().toISOString(),
        client: options.client,
      });
      published.push({
        id: docId,
        version: versionEntry.version,
        chainHash: versionEntry.chain_hash,
      });
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

  // ONE checkpoint sealing every doc published above (createCheckpointFromVault
  // snapshots all published docs in the vault under the checkpoint lock).
  let checkpointNumber: number | null = null;
  if (published.length > 0) {
    const checkpoint = await new CheckpointManager(storage).createCheckpointFromVault(
      `bulk-import (${published.length} docs)`,
    );
    checkpointNumber = checkpoint.checkpoint;
  }

  // ONE index regen for the whole batch (skippable by callers that regen later).
  if (options.regenerateIndex !== false) {
    await storage.regenerateIndex();
  }

  return { published, failed, checkpointNumber };
}
