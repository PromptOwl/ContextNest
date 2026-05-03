/**
 * Document publish orchestration.
 * Ties together versioning, integrity, checkpoints, and index regeneration.
 */

import { createHash } from "node:crypto";
import type { ContextNode, VersionEntry } from "./types.js";
import { NestStorage } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { parseDocument, serializeDocument, getChecksumContent } from "./parser.js";
import { normalizeForHash } from "./integrity.js";

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

  // Bump version
  const currentVersion = node.frontmatter.version || 0;
  const newVersion = currentVersion + 1;
  node.frontmatter.version = newVersion;
  node.frontmatter.status = "published";
  node.frontmatter.updated_at = new Date().toISOString();

  // Compute document body checksum
  const serialized = serializeDocument(node);
  const bodyContent = normalizeForHash(getChecksumContent(serialized));
  const checksum = createHash("sha256").update(bodyContent, "utf-8").digest("hex");
  node.frontmatter.checksum = `sha256:${checksum}`;

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
  const versionManager = new VersionManager(storage);
  const versionEntry = await versionManager.createVersion(node, options.editedBy, {
    note: options.note,
    publishedAt,
  });

  // Gather all published documents for checkpoint
  const allDocs = await storage.discoverDocuments();
  const publishedDocs = allDocs.filter(
    (d) => d.frontmatter.status === "published",
  );

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
