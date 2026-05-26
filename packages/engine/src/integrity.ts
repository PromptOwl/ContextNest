/**
 * SHA-256 hash chain computation and verification (§8).
 */

import { createHash } from "node:crypto";
import type { Checkpoint, VerificationReport, DocumentHistory } from "./types.js";
import { getChecksumContent } from "./parser.js";

const GENESIS_SENTINEL = "contextnest:genesis:v1";

/**
 * Normalize content before hashing to tolerate cloud-sync byte mutations.
 * Strips UTF-8 BOM and normalizes line endings to LF.
 */
export function normalizeForHash(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Compute SHA-256 hash of a string, returning sha256:<hex> format.
 */
export function sha256(input: string): string {
  const hash = createHash("sha256").update(input, "utf-8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Compute content_hash for a version entry (§8.2).
 * - Keyframe: SHA-256 of the full snapshot file content
 * - Diff: SHA-256 of the diff string
 *
 * Content is normalized (BOM stripped, line endings → LF) before hashing
 * so that cloud-sync byte mutations do not break integrity chains.
 */
export function computeContentHash(content: string): string {
  return sha256(normalizeForHash(content));
}

/**
 * Compute chain_hash for a version entry (§8.2).
 *
 * chain_hash[n] = SHA-256(
 *   chain_hash[n-1] + ":" +
 *   content_hash[n] + ":" +
 *   version[n]      + ":" +
 *   edited_by[n]    + ":" +
 *   edited_at[n]
 * )
 *
 * For the first entry, chain_hash[n-1] is replaced by the genesis sentinel.
 */
export function computeChainHash(
  previousChainHash: string | null,
  contentHash: string,
  version: number,
  editedBy: string,
  editedAt: string,
): string {
  const prev = previousChainHash ?? GENESIS_SENTINEL;
  const input = `${prev}:${contentHash}:${version}:${editedBy}:${editedAt}`;
  return sha256(input);
}

/**
 * Compute checkpoint_hash (§8.3).
 *
 * checkpoint_hash[n] = SHA-256(
 *   checkpoint_hash[n-1]    + ":" +
 *   checkpoint[n]           + ":" +
 *   at[n]                   + ":" +
 *   triggered_by[n]         + ":" +
 *   canonical_versions[n]   + ":" +
 *   canonical_chain_hashes[n]
 * )
 */
export function computeCheckpointHash(
  previousCheckpointHash: string | null,
  checkpoint: number,
  at: string,
  triggeredBy: string,
  documentVersions: Record<string, number>,
  documentChainHashes: Record<string, string>,
): string {
  const prev = previousCheckpointHash ?? GENESIS_SENTINEL;
  const canonicalVersions = canonicalJson(documentVersions);
  const canonicalChainHashes = canonicalJson(documentChainHashes);
  const input = `${prev}:${checkpoint}:${at}:${triggeredBy}:${canonicalVersions}:${canonicalChainHashes}`;
  return sha256(input);
}

/**
 * Serialize an object as JSON with sorted keys and no whitespace (§8.3).
 */
export function canonicalJson(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort();
  const entries = sorted.map((key) => `${JSON.stringify(key)}:${JSON.stringify(obj[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Result of comparing live file bytes against a stored checksum.
 *
 * `drifted` is true only when a stored checksum exists and disagrees with
 * the recomputed content hash. Legacy documents with no stored checksum
 * report `drifted: false` (engine treats absence as "not yet tracked").
 */
export interface DriftReport {
  drifted: boolean;
  /** The checksum read from frontmatter, or null if the document has none */
  storedHash: string | null;
  /** SHA-256 of the current body content, normalized */
  actualHash: string;
}

/**
 * Pure drift detection. No I/O, no mutations.
 *
 * Caller hands in the live raw file content and the stored frontmatter
 * checksum. Engine recomputes the body hash (same input as
 * `publishDocument` writes — body only, normalized) and reports.
 *
 * This is the detection chokepoint for the spec's out-of-band edit case
 * (bridge-function-spec Story 3.1, Story 2.1 "intercepts contradictory
 * state during checkpointing"). The function itself does NOT stage a
 * suggestion or mutate the chain — that is the job of the suggestions /
 * approval modules wired in later steps.
 */
export function detectDrift(
  rawContent: string,
  storedChecksum: string | null | undefined,
): DriftReport {
  const actualHash = computeContentHash(getChecksumContent(rawContent));
  if (!storedChecksum) {
    return { drifted: false, storedHash: null, actualHash };
  }
  return {
    drifted: actualHash !== storedChecksum,
    storedHash: storedChecksum,
    actualHash,
  };
}

/** Input to `verifyRemoteDelta`. */
export interface RemoteDeltaInput {
  /** Document ID this delta targets (for error context only) */
  documentId: string;
  /** Raw bytes of the incoming document payload (frontmatter + body) */
  rawContent: string;
  /** Content hash the remote claims for `rawContent` */
  declaredChecksum: string;
  /**
   * Previous chain head the remote believes it is building on. `null` =
   * remote claims this is the first version (genesis case).
   */
  declaredPrevChainHash: string | null;
  /**
   * Local chain head currently known for this document. `null` = local has
   * no record of this document yet (acceptable only when the remote also
   * claims genesis).
   */
  localPrevChainHash: string | null;
}

/** Result of `verifyRemoteDelta`. Caller decides reject / quarantine / merge. */
export interface RemoteDeltaVerification {
  ok: boolean;
  /** Engine-computed content hash for `rawContent` */
  computedHash: string;
  errors: Array<
    | {
        type: "content_hash_mismatch";
        expected: string;
        actual: string;
      }
    | {
        type: "chain_break";
        expectedPrevChainHash: string | null;
        actualPrevChainHash: string | null;
      }
  >;
}

/**
 * Verify a remote-pushed document delta before it is staged or persisted.
 *
 * Spec contract (bridge-function-spec §367, Success Criteria):
 *   "Context can be pushed from desktop to cloud without corrupting hash
 *    chain."
 *
 * Two checks:
 *   1. Content hash — the remote's declared checksum must match the bytes
 *      it sent (transport / tamper detection).
 *   2. Chain continuity — the remote's `declaredPrevChainHash` must equal
 *      the local chain head for the document; otherwise the chain has
 *      forked and the caller must decide whether to quarantine the delta
 *      (bridge-function-spec Story 1.3) or merge.
 *
 * The function never throws on verification failure — it returns a
 * structured result so the bridge can route per spec (quarantine vs.
 * three-way merge vs. reject). Wrap the result with `chainBreakErrorFrom`
 * or check `ok` at the call site.
 */
export function verifyRemoteDelta(
  input: RemoteDeltaInput,
): RemoteDeltaVerification {
  const errors: RemoteDeltaVerification["errors"] = [];
  const computedHash = computeContentHash(getChecksumContent(input.rawContent));

  if (computedHash !== input.declaredChecksum) {
    errors.push({
      type: "content_hash_mismatch",
      expected: input.declaredChecksum,
      actual: computedHash,
    });
  }

  if (input.declaredPrevChainHash !== input.localPrevChainHash) {
    errors.push({
      type: "chain_break",
      expectedPrevChainHash: input.localPrevChainHash,
      actualPrevChainHash: input.declaredPrevChainHash,
    });
  }

  return { ok: errors.length === 0, computedHash, errors };
}

/**
 * Verify the integrity of a document's version chain (§8.4 steps 2-3).
 */
export function verifyDocumentChain(
  docId: string,
  history: DocumentHistory,
  readKeyframe: (version: number) => string | null,
): VerificationReport {
  const errors: VerificationReport["errors"] = [];

  let previousChainHash: string | null = null;

  for (const entry of history.versions) {
    // Step 2: Re-compute content_hash (skip silently if keyframe file
    // missing — chain_hash check below still runs using stored content_hash).
    let actualContent: string | null;
    if (entry.keyframe) {
      actualContent = readKeyframe(entry.version);
    } else {
      actualContent = entry.diff || "";
    }

    if (actualContent !== null) {
      const expectedContentHash = computeContentHash(actualContent);
      if (expectedContentHash !== entry.content_hash) {
        errors.push({
          type: "content_hash_mismatch",
          document: docId,
          version: entry.version,
          expected: expectedContentHash,
          actual: entry.content_hash,
        });
      }
    }

    // Step 3: Re-compute chain_hash (always — uses stored content_hash so
    // works even when keyframe material is unavailable).
    const expectedChainHash = computeChainHash(
      previousChainHash,
      entry.content_hash,
      entry.version,
      entry.edited_by,
      entry.edited_at,
    );
    if (expectedChainHash !== entry.chain_hash) {
      errors.push({
        type: "chain_hash_mismatch",
        document: docId,
        version: entry.version,
        expected: expectedChainHash,
        actual: entry.chain_hash,
      });
    }

    previousChainHash = entry.chain_hash;
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Verify the integrity of the checkpoint chain (§8.4 steps 4-5).
 */
export function verifyCheckpointChain(
  checkpoints: Checkpoint[],
  documentHistories: Map<string, DocumentHistory>,
): VerificationReport {
  const errors: VerificationReport["errors"] = [];

  let previousCheckpointHash: string | null = null;

  for (const cp of checkpoints) {
    // Step 4: Cross-chain binding verification.
    // Skip rows where the current history entry post-dates the checkpoint —
    // that means the document was deleted and recreated; the new identity
    // is not the same as the one the checkpoint sealed.
    for (const [docPath, expectedChainHash] of Object.entries(cp.document_chain_hashes)) {
      const history = documentHistories.get(docPath);
      if (!history) continue;

      const version = cp.document_versions[docPath];
      const entry = history.versions.find((v) => v.version === version);
      if (!entry) continue;
      if (entry.edited_at > cp.at) continue;

      if (entry.chain_hash !== expectedChainHash) {
        errors.push({
          type: "cross_chain_mismatch",
          document: docPath,
          version,
          checkpoint: cp.checkpoint,
          expected: expectedChainHash,
          actual: entry.chain_hash,
        });
      }
    }

    // Step 5: Re-compute checkpoint_hash
    const expectedHash = computeCheckpointHash(
      previousCheckpointHash,
      cp.checkpoint,
      cp.at,
      cp.triggered_by,
      cp.document_versions,
      cp.document_chain_hashes,
    );
    if (expectedHash !== cp.checkpoint_hash) {
      errors.push({
        type: "checkpoint_hash_mismatch",
        checkpoint: cp.checkpoint,
        expected: expectedHash,
        actual: cp.checkpoint_hash,
      });
    }

    previousCheckpointHash = cp.checkpoint_hash;
  }

  return { valid: errors.length === 0, errors };
}
