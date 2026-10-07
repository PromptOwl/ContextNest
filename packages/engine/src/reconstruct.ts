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

  // The artifacts the replay needs are known now, so read them a window at a
  // time — each read is a round trip on a network mount — instead of one by
  // one. A window is applied and released before the next is read, so at most
  // REPLAY_READ_WINDOW artifacts are in flight or in memory. Settled, then
  // consumed in order, so a failure surfaces exactly where the sequential
  // walk hit it.
  const readFor = (entry: (typeof replay)[number]) =>
    entry.tombstone ? null : entry.keyframe ? readKeyframe(entry.version) : readDiff(entry.version);
  let content: string | null = null;
  for (let start = 0; start === 0 || start < replay.length; start += REPLAY_READ_WINDOW) {
    const window = replay.slice(start, start + REPLAY_READ_WINDOW);
    // The first window also reads the anchor keyframe.
    const reads = await Promise.allSettled([
      ...(start === 0 ? [readKeyframe(keyframeVersion)] : []),
      ...window.map(readFor),
    ]);
    if (start === 0) {
      content = value(reads.shift()!);
      if (content === null) {
        throw new ContextNestError(
          `Keyframe file for version ${keyframeVersion} not found for ${docId}`,
          "VERSION_NOT_FOUND",
          "§6",
        );
      }
    }
    content = await applyWindow(docId, content!, window, reads, readDiff);
  }
  return content!;
}

/**
 * `applyPatch`, its position search bounded. A hunk that does not fit where its
 * header says is looked for line by line across the whole text — lines × hunk
 * length, in one synchronous call — so a crafted patch could hold the process
 * for as long as it likes. The comparisons are capped near the patch's own
 * size: a patch that fits where it says, or close by, never comes near the
 * cap. Past it the patch does not apply (`false`). `compared` is the work done.
 */
export function applyPatchBounded(content: string, patch: string): { result: string | false; compared: number } {
  let compared = 0;
  const cap = 2 * patch.length + PATCH_SEARCH_SLACK;
  try {
    const result = applyPatch(content, patch, {
      compareLine: (_line, line, _op, want) => {
        compared += 1 + Math.min(line?.length ?? 0, want.length);
        if (compared > cap) throw PATCH_TOO_FAR;
        return line === want;
      },
    });
    return { result, compared };
  } catch (err) {
    if (err === PATCH_TOO_FAR) return { result: false, compared };
    throw err;
  }
}

const PATCH_TOO_FAR = new Error("the patch does not fit where it says");

/** Characters of line comparison a patch may spend beyond twice its own size. */
const PATCH_SEARCH_SLACK = 2 ** 20;

/** A settled read's value, or its error rethrown. */
function value<T>(r: PromiseSettledResult<T>): T {
  if (r.status === "rejected") throw r.reason;
  return r.value;
}

/** Most version artifacts a replay reads at once (plus its anchor keyframe). */
const REPLAY_READ_WINDOW = 10;

/** Apply one window of replay entries, in order, to `content`. */
async function applyWindow(
  docId: string,
  content: string,
  window: DocumentHistory["versions"],
  reads: PromiseSettledResult<string | null>[],
  readDiff: ArtifactReader,
): Promise<string> {
  for (const [i, entry] of window.entries()) {
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
      const { result } = applyPatchBounded(content, patch);
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
