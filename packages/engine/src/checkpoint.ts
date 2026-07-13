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
import { computeCheckpointHash, computeChainHash } from "./integrity.js";
import { NestStorage } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { stageSuggestion } from "./suggestions.js";
import { isPublished } from "./parser.js";
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
  // Checkpoint drift scan covers every doc including retired ones — a
  // rejected file can still drift on disk and the steward needs to know.
  const docs = await input.storage.discoverDocuments({ includeRetired: true });
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
   * Create a new checkpoint (§7.1) from caller-supplied snapshots.
   *
   * Prefer `createCheckpointFromVault` for the publish path: the snapshots here
   * are captured by the caller before the lock is taken, so a concurrent publish
   * landing between the caller's two reads can leave a doc missing from, or
   * version-skewed within, this checkpoint. Kept for callers (and tests) that
   * need to seal an explicit, possibly-torn snapshot.
   */
  async createCheckpoint(
    triggeredBy: string,
    publishedDocuments: ContextNode[],
    documentHistories: Map<string, DocumentHistory>,
  ): Promise<Checkpoint> {
    // Serialize the read-modify-write of context_history.yaml. Concurrent
    // publishes (e.g. Promise.all) would otherwise each read the same base
    // history and the last writer would clobber the others, silently dropping
    // checkpoints. The lock is in-process only — separate OS processes would
    // need file-level locking, which is out of scope here.
    return this.storage.withCheckpointLock(() =>
      this.sealCheckpoint(triggeredBy, publishedDocuments, documentHistories),
    );
  }

  /**
   * Create a checkpoint whose document snapshots are gathered INSIDE the lock,
   * so the sealed state is a consistent point-in-time view of the vault. This
   * closes the publish-path race where `discoverDocuments` and `findAllHistories`
   * read at different times and a concurrent publish slips between them, leaving
   * a freshly-published doc absent from the checkpoint it should have sealed.
   */
  async createCheckpointFromVault(triggeredBy: string): Promise<Checkpoint> {
    return this.storage.withCheckpointLock(async () => {
      const publishedDocuments = (
        await this.storage.discoverDocuments()
      ).filter(isPublished);
      const documentHistories = await this.storage.findAllHistories();
      return this.sealCheckpoint(
        triggeredBy,
        publishedDocuments,
        documentHistories,
      );
    });
  }

  /**
   * Core checkpoint seal. MUST run inside `withCheckpointLock`: it re-reads
   * context_history.yaml, appends one checkpoint, and writes it back.
   */
  private async sealCheckpoint(
    triggeredBy: string,
    publishedDocuments: ContextNode[],
    documentHistories: Map<string, DocumentHistory>,
  ): Promise<Checkpoint> {
    {
      // Re-read inside the lock so the checkpoint number and previous-hash
      // linkage are based on the latest committed write, not a stale snapshot.
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

      // Build document_chain_hashes from the chain hash of the *version being
      // sealed*, not merely the latest history entry. document_versions and
      // document_chain_hashes are snapshotted from two separate reads in the
      // publish path; if a concurrent publish advances the head between them,
      // sealing the "latest" hash would bind version N to a different version's
      // hash and trip cross_chain_mismatch on verify. Looking up the matching
      // version keeps the seal internally consistent.
      const documentChainHashes: Record<string, string> = {};
      for (const doc of publishedDocuments) {
        const docHistory = documentHistories.get(doc.id);
        if (!docHistory || docHistory.versions.length === 0) continue;
        const sealedVersion = documentVersions[doc.id];
        // Prefer the exact sealed version's hash. If the supplied snapshot does
        // not contain that version (a torn/inconsistent caller snapshot, or
        // corruption), fall back to the latest entry. This deliberately seals a
        // mismatched hash so verifyCheckpointChain reports cross_chain_mismatch
        // — a loud, detectable failure is safer than omitting the hash, which
        // would leave the checkpoint with no integrity anchor for the doc and
        // pass verification silently. The publish path no longer hits this
        // branch: createCheckpointFromVault gathers a consistent snapshot under
        // the lock, so sealedVersion is always present there.
        const entry =
          docHistory.versions.find((v) => v.version === sealedVersion) ??
          docHistory.versions[docHistory.versions.length - 1];
        documentChainHashes[doc.id] = entry.chain_hash;
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
  }

  /**
   * Load checkpoint history.
   */
  async loadCheckpointHistory(): Promise<CheckpointHistory | null> {
    return this.storage.readCheckpointHistory();
  }

  /**
   * Rebuild checkpoint history from per-document history.yaml files (§7.3).
   *
   * Rebuild is a full re-derivation that overwrites context_history.yaml. A
   * naive single read-compute-write races with a concurrent createCheckpoint:
   * a publish that commits between our read of the per-doc histories and our
   * write would be silently clobbered. We cannot simply hold withCheckpointLock
   * across the write — createCheckpoint also takes that lock, so a publish that
   * begins during the rebuild would deadlock against us.
   *
   * Instead we re-derive optimistically: snapshot the published-version set of
   * the per-doc histories, build the chain, write it, then re-read the set. If
   * a concurrent publish changed it, the freshly published doc is missing from
   * what we just wrote, so we re-derive to fold it back in. This converges once
   * no publish lands mid-rebuild.
   *
   * Bounded so a sustained publish storm cannot spin forever: we make at most
   * MAX_REBUILD_ATTEMPTS passes, with a short backoff between them to let an
   * in-flight publish settle before we re-read. After the cap we return the
   * last chain we wrote (still a valid re-derivation; at worst a checkpoint
   * created during the final pass is dropped, recoverable by another rebuild).
   */
  async rebuildCheckpointHistory(): Promise<CheckpointHistory> {
    const MAX_REBUILD_ATTEMPTS = 5;
    const RETRY_BACKOFF_MS = 25;

    let lastHistory: CheckpointHistory = { checkpoints: [] };
    let before = await this.storage.findAllHistories();

    for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt++) {
      lastHistory = this.deriveCheckpointHistory(before);
      await this.storage.writeCheckpointHistory(lastHistory);

      // Did a concurrent publish advance any per-doc history while we were
      // computing/writing? If the published-version set is unchanged, our
      // write reflects everything on disk and we are done.
      const after = await this.storage.findAllHistories();
      if (publishedSignature(before) === publishedSignature(after)) {
        return lastHistory;
      }

      // A publish landed mid-rebuild. Back off briefly so any further in-flight
      // publish can finish, then re-derive from the fresh state (reuse `after`
      // as the next pass's `before` to save a filesystem read).
      if (attempt < MAX_REBUILD_ATTEMPTS - 1) {
        await delay(RETRY_BACKOFF_MS);
      }
      before = after;
    }

    return lastHistory;
  }

  /**
   * Pure re-derivation of the checkpoint chain from per-document histories.
   * Extracted so `rebuildCheckpointHistory` can re-run it on a concurrent
   * publish without duplicating the chain-replay logic.
   */
  private deriveCheckpointHistory(
    allHistories: Map<string, DocumentHistory>,
  ): CheckpointHistory {
    // Step 1: Recompute each version's chain hash per document instead of
    // trusting the value stored on disk. Rebuild is the documented §7.3 repair
    // path; copying stored hashes verbatim would preserve corruption (e.g.
    // duplicate version numbers from re-imports) and even launder a tampered
    // chain_hash into a freshly "repaired" chain that then verifies clean.
    //
    // We replay each doc's entries in chain order, recompute each chain hash,
    // and remember the recomputed hash of the FIRST occurrence of each
    // (doc, version). That first occurrence is exactly the entry
    // verifyCheckpointChain looks up, so an untampered chain reproduces its
    // stored hash (the rebuild stays verifiable) while a tampered entry is
    // replaced by its correct recomputation rather than re-sealed.
    const recomputed = new Map<
      string,
      Map<number, { hash: string; publishedAt: string }>
    >();
    for (const [docId, history] of allHistories) {
      const perVersion = new Map<number, { hash: string; publishedAt: string }>();
      let prevChainHash: string | null = null;
      for (const entry of history.versions) {
        const hash = computeChainHash(
          prevChainHash,
          entry.content_hash,
          entry.version,
          entry.edited_by,
          entry.edited_at,
        );
        prevChainHash = hash;
        // Only published versions seed checkpoints; keep the first occurrence.
        if (entry.published_at && !perVersion.has(entry.version)) {
          perVersion.set(entry.version, { hash, publishedAt: entry.published_at });
        }
      }
      recomputed.set(docId, perVersion);
    }

    // Step 2: One tuple per (docId, version) first occurrence.
    const tuples: Array<{
      docId: string;
      version: number;
      publishedAt: string;
      chainHash: string;
    }> = [];

    for (const [docId, perVersion] of recomputed) {
      for (const [version, { hash, publishedAt }] of perVersion) {
        tuples.push({ docId, version, publishedAt, chainHash: hash });
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

    return { checkpoints };
  }
}

/**
 * Stable signature of the published-version set across all documents. Two calls
 * return equal strings iff the same (docId, version) pairs are published on
 * disk — the only input that affects the rebuilt checkpoint chain. Used to
 * detect a concurrent publish landing during a rebuild pass.
 */
function publishedSignature(
  histories: Map<string, DocumentHistory>,
): string {
  const parts: string[] = [];
  for (const [docId, history] of histories) {
    const versions = history.versions
      .filter((v) => v.published_at)
      .map((v) => v.version)
      .sort((a, b) => a - b);
    parts.push(`${docId}:${versions.join(",")}`);
  }
  return parts.sort().join("|");
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
