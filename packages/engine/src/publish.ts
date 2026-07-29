/**
 * Document publish orchestration.
 * Ties together versioning, integrity, checkpoints, and index regeneration.
 */

import type { ContextNode, VersionEntry } from "./types.js";
import { NestStorage } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { serializeDocument, getChecksumContent, isRejected } from "./parser.js";
import { computeContentHash } from "./integrity.js";
import { RejectedDocumentError } from "./errors.js";

export interface PublishOptions {
  editedBy: string;
  note?: string;
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

  // Bump version
  const currentVersion = node.frontmatter.version || 0;
  const newVersion = currentVersion + 1;
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

  const publishOne = async (docId: string): Promise<void> => {
    try {
      let node = await storage.readDocument(docId);
      if (isRejected(node)) throw new RejectedDocumentError(docId);

      const versionManager = new VersionManager(storage);
      const existingHistory = await storage.readHistory(docId);
      if (!existingHistory && (node.frontmatter.version || 0) > 1) {
        await versionManager.createVersion(node, "system:seed", {
          note: "Pre-publish snapshot (auto-seeded — no prior history)",
        });
      }

      const newVersion = (node.frontmatter.version || 0) + 1;
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
      });
      published.push({
        id: docId,
        version: versionEntry.version,
        chainHash: versionEntry.chain_hash,
      });
    } catch (err) {
      failed.push({ id: docId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Bounded-concurrency pass — no cross-doc dependency, so a simple sliding
  // window is enough (avoids pulling in a p-limit dependency).
  for (let i = 0; i < docIds.length; i += concurrency) {
    await Promise.all(docIds.slice(i, i + concurrency).map(publishOne));
  }

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
