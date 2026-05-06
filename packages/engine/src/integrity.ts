/**
 * SHA-256 hash chain computation and verification (§8).
 */

import { createHash } from "node:crypto";
import type { Checkpoint, VerificationReport, DocumentHistory } from "./types.js";

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
    // Step 2: Re-compute content_hash
    let actualContent: string;
    if (entry.keyframe) {
      const keyframeContent = readKeyframe(entry.version);
      if (keyframeContent === null) {
        // Can't verify without keyframe file
        continue;
      }
      actualContent = keyframeContent;
    } else {
      actualContent = entry.diff || "";
    }

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

    // Step 3: Re-compute chain_hash
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
    // Step 4: Cross-chain binding verification
    for (const [docPath, expectedChainHash] of Object.entries(cp.document_chain_hashes)) {
      const history = documentHistories.get(docPath);
      if (!history) continue;

      const version = cp.document_versions[docPath];
      const entry = history.versions.find((v) => v.version === version);
      if (!entry) continue;

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
