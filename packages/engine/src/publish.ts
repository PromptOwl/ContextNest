/**
 * Document publish orchestration.
 * Ties together versioning, integrity, checkpoints, and index regeneration.
 */

import type { ContextNode, VersionEntry } from "./types.js";
import { NestStorage } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { serializeDocument, getChecksumContent, isPublished } from "./parser.js";
import { computeContentHash } from "./integrity.js";

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

  // Gather all published documents for checkpoint
  const allDocs = await storage.discoverDocuments();
  const publishedDocs = allDocs.filter(isPublished);

  // Gather all document histories
  const histories = await storage.findAllHistories();

  // Create checkpoint
  const checkpointManager = new CheckpointManager(storage);
  const checkpoint = await checkpointManager.createCheckpoint(
    docId,
    publishedDocs,
    histories,
  );

  return {
    node,
    versionEntry,
    checkpointNumber: checkpoint.checkpoint,
  };
}
