/**
 * Pure version replay (§6.1): rebuild one recorded version of a document from
 * its history, a keyframe reader and a diff reader.
 *
 * Extracted from `VersionManager.reconstructVersion` so integrity verification
 * (`NestStorage.verifyHistoryChain`) can replay a chain over its pre-loaded
 * artifact bytes without importing the storage-backed VersionManager — which
 * would be a module cycle. The readers return the artifact content for a
 * version, or null when there is none; they may be sync (a map) or async
 * (storage reads).
 */

import { applyPatch } from "diff";
import type { DocumentHistory } from "./types.js";
import { ContextNestError, ForgottenVersionError } from "./errors.js";

/** Artifact content for a version, or null when there is none to read. */
export type ArtifactReader = (
  version: number,
) => string | null | Promise<string | null>;

/**
 * Reconstruct a specific version of a document (§6.1).
 * Finds nearest keyframe and applies diffs forward.
 */
export async function reconstructFromHistory(
  docId: string,
  history: DocumentHistory,
  targetVersion: number,
  readKeyframe: ArtifactReader,
  readDiff: ArtifactReader,
): Promise<string> {
  // The walk below starts at the nearest keyframe at or before the target and
  // replays diffs forward. Ask for a version the history does not contain and
  // there are no diffs to replay, so it returns the keyframe's content as
  // though it were the version requested — a silently wrong answer in the one
  // place that must never give one. Refuse instead.
  const target = history.versions.find((entry) => entry.version === targetVersion);
  if (!target) {
    throw new ContextNestError(
      `Version ${targetVersion} not found for ${docId}`,
      "VERSION_NOT_FOUND",
      "§6",
    );
  }
  // Forget protocol (§6.3.2): the version existed, but its content was
  // erased on purpose. Say so — never fall back to a neighbouring keyframe.
  if (target.tombstone) throw new ForgottenVersionError(docId, targetVersion);

  // Find the nearest keyframe at or before target version. A tombstoned
  // keyframe has no file left, so it cannot anchor a replay.
  let keyframeVersion = -1;
  for (const entry of history.versions) {
    if (entry.keyframe && !entry.tombstone && entry.version <= targetVersion) {
      keyframeVersion = entry.version;
    }
  }

  if (keyframeVersion === -1) {
    throw new ContextNestError(
      `No keyframe found at or before version ${targetVersion} for ${docId}`,
      "VERSION_NOT_FOUND",
      "§6",
    );
  }

  // Read keyframe content
  let content = await readKeyframe(keyframeVersion);
  if (content === null) {
    throw new ContextNestError(
      `Keyframe file for version ${keyframeVersion} not found for ${docId}`,
      "VERSION_NOT_FOUND",
      "§6",
    );
  }

  // Apply diffs forward from keyframe to target
  for (const entry of history.versions) {
    if (entry.version <= keyframeVersion) continue;
    if (entry.version > targetVersion) break;
    // A forgotten version between the anchor and the target means the diff
    // chain runs through erased content. The forget protocol re-keyframes
    // the first retained version after a range precisely so this cannot
    // happen; reaching it means the history was altered afterwards.
    if (entry.tombstone) throw new ForgottenVersionError(docId, entry.version);

    if (entry.keyframe) {
      // This is another keyframe — read it directly
      const kf = await readKeyframe(entry.version);
      if (kf !== null) {
        content = kf;
        continue;
      }
    }

    // v{N}.diff on disk, falling back to the patch stored inline on the
    // entry by histories written before diffs were externalized.
    const patch = (await readDiff(entry.version)) ?? entry.diff;
    if (patch) {
      const result = applyPatch(content, patch);
      if (typeof result === "string") {
        content = result;
      } else if (result === false) {
        throw new ContextNestError(
          `Failed to apply diff for version ${entry.version} of ${docId}`,
          "RECONSTRUCTION_FAILED",
          "§6",
        );
      }
    }
  }

  return content;
}
