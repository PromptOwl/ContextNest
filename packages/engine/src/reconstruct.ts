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

  // The entries to replay, keyframe to target.
  const replay: typeof history.versions = [];
  for (const entry of history.versions) {
    if (entry.version <= keyframeVersion) continue;
    if (entry.version > targetVersion) break;
    replay.push(entry);
  }

  // Every artifact the replay needs is known now, so read them together —
  // each read is a round trip on a network mount. Settled, then consumed in
  // order, so a failure surfaces exactly where the sequential walk hit it.
  const [anchor, ...reads] = await Promise.allSettled([
    readKeyframe(keyframeVersion),
    ...replay.map((entry) =>
      entry.tombstone ? null : entry.keyframe ? readKeyframe(entry.version) : readDiff(entry.version),
    ),
  ]);
  const value = <T>(r: PromiseSettledResult<T>): T => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  };

  let content = value(anchor);
  if (content === null) {
    throw new ContextNestError(
      `Keyframe file for version ${keyframeVersion} not found for ${docId}`,
      "VERSION_NOT_FOUND",
      "§6",
    );
  }

  // Apply diffs forward from keyframe to target
  for (const [i, entry] of replay.entries()) {
    // A forgotten version between the anchor and the target means the diff
    // chain runs through erased content. The forget protocol re-keyframes
    // the first retained version after a range precisely so this cannot
    // happen; reaching it means the history was altered afterwards.
    if (entry.tombstone) throw new ForgottenVersionError(docId, entry.version);
    const read = value(reads[i]);
    if (entry.keyframe) {
      // This is another keyframe — use it directly when its file exists
      if (read !== null) {
        content = read;
        continue;
      }
    }

    // v{N}.diff on disk, falling back to the patch stored inline on the
    // entry by histories written before diffs were externalized.
    const diff = entry.keyframe ? await readDiff(entry.version) : read;
    const patch = diff ?? entry.diff;
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
