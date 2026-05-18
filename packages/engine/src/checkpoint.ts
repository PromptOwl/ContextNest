/**
 * Nest checkpoint management (§7) + checkpoint-time drift scan
 * (bridge-function-spec Story 2.1, Story 3.1).
 */

import type {
  Checkpoint,
  CheckpointHistory,
  ContextNode,
  DocumentHistory,
  GovernanceTier,
  SuggestionMeta,
} from "./types.js";
import { computeCheckpointHash } from "./integrity.js";
import { NestStorage } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { stageSuggestion } from "./suggestions.js";
import {
  classifyDocument,
  type ClassificationManifest,
} from "./classification.js";

/** Latest checkpoint object, or null if history empty/missing. */
export function getLatestCheckpoint(
  history: CheckpointHistory | null | undefined,
): Checkpoint | null {
  return history?.checkpoints?.at(-1) ?? null;
}

/** Latest checkpoint number, or 0 if history empty/missing. */
export function getLatestCheckpointNumber(
  history: CheckpointHistory | null | undefined,
): number {
  return getLatestCheckpoint(history)?.checkpoint ?? 0;
}

/** Input to `scanCheckpointDrift`. */
export interface CheckpointDriftScanInput {
  storage: NestStorage;
  /** Actor identifier recorded on every staged suggestion (e.g. "system:checkpoint"). */
  actor: string;
  /**
   * Optional classification manifest used to fill in `zone` / `governance`
   * when a drifted document's frontmatter does not declare them
   * (zone-classification-rbac-spec §2.1 cascade).
   */
  manifest?: ClassificationManifest;
  /**
   * Default zone used by the L3 fallback when neither frontmatter metadata
   * nor a folder match resolves a zone. If unset, undeclared documents are
   * skipped with reason "unresolved-zone".
   */
  defaultZone?: string;
  /** Default governance tier when none is resolved. Defaults to "standard". */
  defaultGovernance?: GovernanceTier;
}

/** One entry per document the scan looked at. */
export interface DriftScanEntry {
  documentId: string;
  drifted: boolean;
  staged?: SuggestionMeta;
  skippedReason?: string;
}

/** Aggregate result of a checkpoint-time drift scan. */
export interface CheckpointDriftScanResult {
  scanned: number;
  drifted: number;
  stagedCount: number;
  skippedCount: number;
  entries: DriftScanEntry[];
}

/**
 * Walk the entire vault, detect out-of-band edits, and stage each one as
 * a suggestion under `_suggestions/`. Per bridge-function-spec Story 2.1
 * and Story 3.1, this is the spec-prescribed interception point: drift
 * captured at checkpoint time, canonical document never mutated.
 *
 * Skipped cases (returned with `skippedReason`, not staged):
 *   - Document has no version history (legacy / never published) — nothing
 *     to diff against.
 *   - Document has no `frontmatter.checksum` — `detectDrift` cannot decide.
 *   - Zone unresolved and no `defaultZone` configured.
 *   - Live file unreadable (race with delete).
 *
 * The scan never throws on a per-doc problem — bad docs are added to
 * `entries` with a reason and the scan continues. This keeps a checkpoint
 * from failing wholesale because of one ill-formed file.
 */
export async function scanCheckpointDrift(
  input: CheckpointDriftScanInput,
): Promise<CheckpointDriftScanResult> {
  const docs = await input.storage.discoverDocuments();
  const entries: DriftScanEntry[] = [];

  for (const doc of docs) {
    const entry = await scanOneDocument(doc, input);
    entries.push(entry);
  }

  return {
    scanned: entries.length,
    drifted: entries.filter((e) => e.drifted).length,
    stagedCount: entries.filter((e) => e.staged).length,
    skippedCount: entries.filter((e) => e.skippedReason).length,
    entries,
  };
}

async function scanOneDocument(
  liveNode: ContextNode,
  input: CheckpointDriftScanInput,
): Promise<DriftScanEntry> {
  const documentId = liveNode.id;

  // Cheap path: no stored checksum means engine cannot decide drift.
  if (!liveNode.frontmatter.checksum) {
    return {
      documentId,
      drifted: false,
      skippedReason: "no-stored-checksum",
    };
  }

  const drift = await input.storage.detectDocumentDrift(documentId);
  if (!drift || !drift.drifted) {
    return { documentId, drifted: false };
  }

  // Need a chain head to diff against — skip legacy unseeded docs.
  const history = await input.storage.readHistory(documentId);
  if (!history || history.versions.length === 0) {
    return {
      documentId,
      drifted: true,
      skippedReason: "no-version-history",
    };
  }

  let approvedRaw: string;
  try {
    const latest = history.versions[history.versions.length - 1];
    approvedRaw = await new VersionManager(input.storage).reconstructVersion(
      documentId,
      latest.version,
    );
  } catch (err) {
    return {
      documentId,
      drifted: true,
      skippedReason: `chain-head-unreachable: ${(err as Error).message}`,
    };
  }

  const resolved = resolveZoneAndTier(liveNode, input);
  if (!resolved) {
    return {
      documentId,
      drifted: true,
      skippedReason: "unresolved-zone",
    };
  }

  const result = await stageSuggestion({
    storage: input.storage,
    documentId,
    approvedRawContent: approvedRaw,
    proposedRawContent: liveNode.rawContent,
    source: "out-of-band-edit",
    actor: input.actor,
    zone: resolved.zone,
    docTier: resolved.governance,
    note: "detected during checkpoint scan",
  });

  return {
    documentId,
    drifted: true,
    staged: result.meta,
  };
}

function resolveZoneAndTier(
  node: ContextNode,
  input: CheckpointDriftScanInput,
): { zone: string; governance: GovernanceTier } | null {
  const fmZone = node.frontmatter.zone;
  const fmGov = node.frontmatter.governance;

  if (fmZone && fmGov) {
    return { zone: fmZone, governance: fmGov };
  }

  if (input.manifest) {
    const cls = classifyDocument({
      documentPath: `${node.id}.md`,
      frontmatter: node.frontmatter,
      manifest: input.manifest,
      defaultZone: input.defaultZone ?? "",
    });
    if (cls.zone) {
      return {
        zone: cls.zone,
        governance: cls.governance ?? input.defaultGovernance ?? "standard",
      };
    }
  }

  if (input.defaultZone) {
    return {
      zone: fmZone ?? input.defaultZone,
      governance: fmGov ?? input.defaultGovernance ?? "standard",
    };
  }

  return null;
}

export class CheckpointManager {
  constructor(private storage: NestStorage) {}

  /**
   * Run the drift scan against this manager's storage. Returns the scan
   * report without creating a checkpoint — caller decides whether to
   * proceed (e.g. abort on drifted entries, surface to Inbox, etc.).
   */
  async scanForDrift(
    input: Omit<CheckpointDriftScanInput, "storage">,
  ): Promise<CheckpointDriftScanResult> {
    return scanCheckpointDrift({ storage: this.storage, ...input });
  }

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

    const previousCheckpoint = getLatestCheckpoint(history);

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
