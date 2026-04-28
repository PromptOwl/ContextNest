/**
 * Nest checkpoint management (§7).
 */

import type {
  Checkpoint,
  CheckpointHistory,
  ContextNode,
  DocumentHistory,
} from "./types.js";
import { computeCheckpointHash } from "./integrity.js";
import { NestStorage } from "./storage.js";

export class CheckpointManager {
  constructor(private storage: NestStorage) {}

  /**
   * Create a new checkpoint (§7.1).
   * Called each time a document is published.
   */
  async createCheckpoint(
    triggeredBy: string,
    publishedDocuments: ContextNode[],
    documentHistories: Map<string, DocumentHistory>,
  ): Promise<Checkpoint> {
    const history = (await this.storage.readCheckpointHistory()) || {
      checkpoints: [],
    };

    const previousCheckpoint =
      history.checkpoints.length > 0
        ? history.checkpoints[history.checkpoints.length - 1]
        : null;

    const checkpointNumber = previousCheckpoint
      ? previousCheckpoint.checkpoint + 1
      : 1;
    const at = new Date().toISOString();

    // Build document_versions map
    const documentVersions: Record<string, number> = {};
    for (const doc of publishedDocuments) {
      documentVersions[doc.id] = doc.frontmatter.version || 1;
    }

    // Build document_chain_hashes from each document's latest chain_hash
    const documentChainHashes: Record<string, string> = {};
    for (const doc of publishedDocuments) {
      const docHistory = documentHistories.get(doc.id);
      if (docHistory && docHistory.versions.length > 0) {
        const latestEntry = docHistory.versions[docHistory.versions.length - 1];
        documentChainHashes[doc.id] = latestEntry.chain_hash;
      }
    }

    const checkpointHash = computeCheckpointHash(
      previousCheckpoint?.checkpoint_hash ?? null,
      checkpointNumber,
      at,
      triggeredBy,
      documentVersions,
      documentChainHashes,
    );

    const checkpoint: Checkpoint = {
      checkpoint: checkpointNumber,
      at,
      triggered_by: triggeredBy,
      document_versions: documentVersions,
      document_chain_hashes: documentChainHashes,
      checkpoint_hash: checkpointHash,
    };

    history.checkpoints.push(checkpoint);
    await this.storage.writeCheckpointHistory(history);

    return checkpoint;
  }

  /**
   * Load checkpoint history.
   */
  async loadCheckpointHistory(): Promise<CheckpointHistory | null> {
    return this.storage.readCheckpointHistory();
  }

  /**
   * Rebuild checkpoint history from per-document history.yaml files (§7.3).
   */
  async rebuildCheckpointHistory(): Promise<CheckpointHistory> {
    const allHistories = await this.storage.findAllHistories();

    // Step 2: Collect all {docId, version, published_at} tuples
    const tuples: Array<{
      docId: string;
      version: number;
      publishedAt: string;
      chainHash: string;
    }> = [];

    for (const [docId, history] of allHistories) {
      for (const entry of history.versions) {
        if (entry.published_at) {
          tuples.push({
            docId,
            version: entry.version,
            publishedAt: entry.published_at,
            chainHash: entry.chain_hash,
          });
        }
      }
    }

    // Step 3: Sort by published_at ascending, tie-break by docId then version
    tuples.sort((a, b) => {
      const timeCompare = a.publishedAt.localeCompare(b.publishedAt);
      if (timeCompare !== 0) return timeCompare;
      const pathCompare = a.docId.localeCompare(b.docId);
      if (pathCompare !== 0) return pathCompare;
      return a.version - b.version;
    });

    // Step 4-5: Replay in order, maintaining running document_versions map
    const runningVersions: Record<string, number> = {};
    const runningChainHashes: Record<string, string> = {};
    const checkpoints: Checkpoint[] = [];
    let previousHash: string | null = null;

    for (let i = 0; i < tuples.length; i++) {
      const tuple = tuples[i];
      runningVersions[tuple.docId] = tuple.version;
      runningChainHashes[tuple.docId] = tuple.chainHash;

      const checkpointNumber = i + 1;
      const documentVersions = { ...runningVersions };
      const documentChainHashes = { ...runningChainHashes };

      const checkpointHash = computeCheckpointHash(
        previousHash,
        checkpointNumber,
        tuple.publishedAt,
        tuple.docId,
        documentVersions,
        documentChainHashes,
      );

      checkpoints.push({
        checkpoint: checkpointNumber,
        at: tuple.publishedAt,
        triggered_by: tuple.docId,
        document_versions: documentVersions,
        document_chain_hashes: documentChainHashes,
        checkpoint_hash: checkpointHash,
      });

      previousHash = checkpointHash;
    }

    const history: CheckpointHistory = { checkpoints };

    // Step 6: Write to .versions/context_history.yaml
    await this.storage.writeCheckpointHistory(history);

    return history;
  }
}
