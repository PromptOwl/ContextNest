/**
 * Document forget / tombstone orchestration (ctx-forget-strict-pr-spec §1).
 *
 * `ctx forget` is a SUPERSEDING version, not a hard delete. The live file and
 * its full version history are retained for audit; the node is flagged
 * `frontmatter.forgotten = true` so every retrieval path (`GraphQueryEngine`,
 * `Resolver`) excludes it via `isTombstoned`. A `document.forgotten` event is
 * appended to the hash-chain log so compliance teams can reconstruct what was
 * forgotten, by whom, and when.
 *
 * Modeled on `publish.ts` for version + checkpoint + chain integrity. Never
 * calls `deleteDocument` — a tombstone preserves history by design.
 */

import type {
  ContextNode,
  HashChainEvent,
  VersionEntry,
} from "./types.js";
import { NestStorage } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { ChainEventLog } from "./chain-log.js";
import { serializeDocument, getChecksumContent, isPublished } from "./parser.js";
import { computeContentHash } from "./integrity.js";

export interface ForgetOptions {
  /** Why the node was forgotten (e.g. GDPR erasure request, supersession). */
  reason?: string;
  /** Principal who requested the forget (data subject, steward, regulator). */
  requestedBy?: string;
  /** ISO-8601 timestamp the forget took effect. Defaults to now. */
  at?: string;
  /** Opaque actor string recorded in version history + chain event. */
  editedBy: string;
}

export interface ForgetResult {
  node: ContextNode;
  versionEntry: VersionEntry;
  checkpointNumber: number;
  chainEvent: HashChainEvent;
}

/**
 * Forget (tombstone) a document: flag it forgotten, record provenance, bump
 * version, create a version entry + checkpoint, and append a
 * `document.forgotten` hash-chain event. The node remains on disk and in
 * history; only retrieval is suppressed.
 */
export async function forgetDocument(
  storage: NestStorage,
  docId: string,
  options: ForgetOptions,
): Promise<ForgetResult> {
  // Read current document
  let node = await storage.readDocument(docId);

  const at = options.at ?? new Date().toISOString();

  // Flag as tombstoned and record provenance.
  node.frontmatter.forgotten = true;
  node.frontmatter.forget_record = {
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.requestedBy !== undefined
      ? { requested_by: options.requestedBy }
      : {}),
    at,
  };

  // Bump version
  const currentVersion = node.frontmatter.version || 0;
  const newVersion = currentVersion + 1;
  node.frontmatter.version = newVersion;
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

  // Write updated document to disk (file is NOT deleted — tombstone retains it)
  await storage.writeDocument(docId, finalContent);

  // Re-read to get clean parse
  node = await storage.readDocument(docId);

  const versionManager = new VersionManager(storage);
  const forgottenAt = new Date().toISOString();

  // Create version entry — keeps the hash chain continuous (a tombstone is a
  // superseding version, not a hard delete).
  const versionEntry = await versionManager.createVersion(node, options.editedBy, {
    note: options.reason ? `forget: ${options.reason}` : "forget",
    publishedAt: forgottenAt,
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

  // Append a first-class governance event to the hash-chain log.
  const chainEvent: HashChainEvent = {
    event_id: makeEventId(docId, "document.forgotten", versionEntry.version),
    event_type: "document.forgotten",
    timestamp: versionEntry.edited_at,
    actor: options.editedBy,
    document_id: docId,
    resulting_hash: versionEntry.chain_hash,
    action_metadata: {
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.requestedBy !== undefined
        ? { requested_by: options.requestedBy }
        : {}),
      at,
    },
  };
  await new ChainEventLog(storage).append(chainEvent);

  return {
    node,
    versionEntry,
    checkpointNumber: checkpoint.checkpoint,
    chainEvent,
  };
}

/**
 * Read the forget audit trail — `document.forgotten` / `document.unforgotten`
 * events from the hash-chain log. When `path` is given, scope to that document.
 */
export async function forgetLog(
  storage: NestStorage,
  path?: string,
): Promise<HashChainEvent[]> {
  const log = new ChainEventLog(storage);
  if (path) {
    const byDoc = await log.readByDocument(path);
    return byDoc.filter(
      (e) =>
        e.event_type === "document.forgotten" ||
        e.event_type === "document.unforgotten",
    );
  }
  return log.readByType(["document.forgotten", "document.unforgotten"]);
}

function makeEventId(...parts: Array<string | number>): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `evt_${ts}_${parts.join("_")}`;
}
