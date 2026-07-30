/**
 * Document version management (§6).
 * Keyframe + diff model with history.yaml tracking.
 */

import { createPatch, applyPatch } from "diff";
import type { ContextNode, DocumentHistory, VersionEntry } from "./types.js";
import { computeContentHash, computeChainHash } from "./integrity.js";
import { serializeDocument } from "./parser.js";
import { NestStorage } from "./storage.js";
import { ContextNestError } from "./errors.js";

const DEFAULT_KEYFRAME_INTERVAL = 10;

export class VersionManager {
  constructor(private storage: NestStorage) {}

  /**
   * Next version number for a document — ahead of BOTH the caller's hint
   * (frontmatter version, a DB row count) and everything already recorded in
   * history.yaml.
   *
   * history.yaml is append-only, so the next entry MUST outrank every entry in
   * it. Numbering from frontmatter alone lets a document whose frontmatter lags
   * its history — a copied/imported vault, a restored backup, a doc whose
   * frontmatter was reset — graft a SECOND chain onto the first: duplicate
   * v{N} entries, keyframe files overwritten at the same number, and
   * reconstructVersion() failing on the first diff after the graft.
   */
  async nextVersion(docId: string, hint = 0): Promise<number> {
    const history = await this.storage.readHistory(docId);
    const recorded = (history?.versions ?? []).reduce(
      (max, entry) => Math.max(max, entry.version),
      0,
    );
    return Math.max(hint, recorded) + 1;
  }

  /**
   * Create a new version of a document (§6.1).
   * Appends to history.yaml, writes keyframe if at keyframe interval.
   */
  async createVersion(
    node: ContextNode,
    editedBy: string,
    options: {
      note?: string;
      publishedAt?: string;
    } = {},
  ): Promise<VersionEntry> {
    const history = (await this.storage.readHistory(node.id)) || {
      keyframe_interval: DEFAULT_KEYFRAME_INTERVAL,
      versions: [],
    };

    const currentVersion = node.frontmatter.version || 1;
    let isKeyframe =
      history.versions.length === 0 ||
      currentVersion % history.keyframe_interval === 1 ||
      currentVersion === 1;

    const fullContent = serializeDocument(node);
    const editedAt = new Date().toISOString();

    let contentForHash: string;
    let diff: string | undefined;

    // A diff is only storable if the version it is relative to can still be
    // rebuilt. When the chain ahead of this entry is unreadable — history
    // grafted by an older import, a hand-edited history.yaml, a keyframe file
    // lost — a diff would make this version and every later one permanently
    // unreconstructable. Fall back to a keyframe: the chain restarts cleanly
    // from here and stays readable forward.
    let previousContent: string | null = null;
    if (!isKeyframe) {
      try {
        previousContent = await this.reconstructVersion(
          node.id,
          currentVersion - 1,
        );
      } catch {
        isKeyframe = true;
      }
    }

    if (previousContent === null) {
      // Write keyframe snapshot
      await this.storage.writeKeyframe(node.id, currentVersion, fullContent);
      contentForHash = fullContent;
    } else {
      diff = createPatch(
        `v${currentVersion - 1}`,
        previousContent,
        fullContent,
        `v${currentVersion - 1}`,
        `v${currentVersion}`,
      );
      // The change log lives in its own v{N}.diff file, NOT inline on the
      // history entry: history.yaml stays metadata-only (it is rewritten whole
      // on every version, so inline patches made each edit cost O(total
      // history)), and every version gains a standalone, readable artifact.
      await this.storage.writeDiff(node.id, currentVersion, diff);
      contentForHash = diff;
    }

    const contentHash = computeContentHash(contentForHash);

    // Get previous chain hash
    const previousChainHash =
      history.versions.length > 0
        ? history.versions[history.versions.length - 1].chain_hash
        : null;

    const chainHash = computeChainHash(
      previousChainHash,
      contentHash,
      currentVersion,
      editedBy,
      editedAt,
    );

    const entry: VersionEntry = {
      version: currentVersion,
      ...(isKeyframe ? { keyframe: true } : {}),
      edited_by: editedBy,
      edited_at: editedAt,
      ...(options.publishedAt ? { published_at: options.publishedAt } : {}),
      ...(options.note ? { note: options.note } : {}),
      content_hash: contentHash,
      chain_hash: chainHash,
    };

    history.versions.push(entry);
    await this.storage.writeHistory(node.id, history);

    return entry;
  }

  /**
   * Reconstruct a specific version of a document (§6.1).
   * Finds nearest keyframe and applies diffs forward.
   */
  async reconstructVersion(docId: string, targetVersion: number): Promise<string> {
    const history = await this.storage.readHistory(docId);
    if (!history) {
      throw new ContextNestError(
        `No version history found for ${docId}`,
        "VERSION_NOT_FOUND",
        "§6",
      );
    }

    // Find the nearest keyframe at or before target version
    let keyframeVersion = -1;
    for (const entry of history.versions) {
      if (entry.keyframe && entry.version <= targetVersion) {
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
    let content = await this.storage.readKeyframe(docId, keyframeVersion);
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

      if (entry.keyframe) {
        // This is another keyframe — read it directly
        const kf = await this.storage.readKeyframe(docId, entry.version);
        if (kf !== null) {
          content = kf;
          continue;
        }
      }

      // v{N}.diff on disk, falling back to the patch stored inline on the
      // entry by histories written before diffs were externalized.
      const patch =
        (await this.storage.readDiff(docId, entry.version)) ?? entry.diff;
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

  /**
   * Make a document's LATEST version readable again after a chain graft.
   *
   * A history grafted by an older import — duplicate version numbers, keyframe
   * files overwritten at the same number — fails reconstruction from the graft
   * point on, so even the CURRENT version reads as empty. This re-anchors the
   * latest recorded version on the live document: writes it as a keyframe and
   * re-hashes that entry, without adding a version or renumbering anything
   * already recorded. Versions from before the graft stay unreadable — those
   * bytes were overwritten and are genuinely gone.
   *
   * Entries recorded AFTER the highest version are dropped: they can only be a
   * graft tail re-treading numbers the chain already used, and leaving them is
   * what makes reconstruct pick a stale keyframe over the re-anchored one. The
   * content they described is unreachable either way — the live document is the
   * state they led to, and that is exactly what gets keyframed here.
   *
   * Idempotent no-op when the latest version already reconstructs. Returns true
   * only when it repaired something.
   */
  async repairLatestVersion(docId: string): Promise<boolean> {
    const history = await this.storage.readHistory(docId);
    if (!history || history.versions.length === 0) return false;

    // Last entry holding the highest version — a grafted history is not sorted,
    // so take the max rather than trusting the tail.
    let index = 0;
    for (let i = 1; i < history.versions.length; i++) {
      if (history.versions[i].version >= history.versions[index].version) index = i;
    }
    const latest = history.versions[index];

    try {
      await this.reconstructVersion(docId, latest.version);
      return false;
    } catch {
      // Falls through to the repair below.
    }

    const fullContent = serializeDocument(await this.storage.readDocument(docId));
    await this.storage.writeKeyframe(docId, latest.version, fullContent);

    latest.keyframe = true;
    delete latest.diff;
    // The entry hashed a diff before; it holds full content now, so re-hash it
    // (and its chain link) or integrity verification flags the keyframe.
    latest.content_hash = computeContentHash(fullContent);
    latest.chain_hash = computeChainHash(
      index > 0 ? history.versions[index - 1].chain_hash : null,
      latest.content_hash,
      latest.version,
      latest.edited_by,
      latest.edited_at,
    );

    // Drop the graft tail so the re-anchored keyframe is the last one at or
    // below any target — otherwise a trailing lower-numbered keyframe wins the
    // nearest-keyframe scan in reconstructVersion and the chain stays broken.
    history.versions = history.versions.slice(0, index + 1);

    await this.storage.writeHistory(docId, history);
    return true;
  }

  /**
   * The change log for a single version — the unified diff taking the previous
   * version to this one. Reads v{version}.diff, falling back to the patch
   * stored inline by histories written before diffs were externalized.
   *
   * Null for a keyframe (it is a full snapshot, so there is no patch) and for a
   * version that has neither file nor inline patch. Cheap: one small file read,
   * no chain replay — this is what lets a version list render every change
   * without reconstructing every body.
   */
  async getDiff(docId: string, version: number): Promise<string | null> {
    const history = await this.storage.readHistory(docId);
    const entry = history?.versions.find((e) => e.version === version);
    if (entry?.keyframe) return null;
    return (await this.storage.readDiff(docId, version)) ?? entry?.diff ?? null;
  }

  /**
   * Move inline patches out of history.yaml into v{N}.diff files.
   *
   * Reads keep working either way (reconstructVersion falls back to the inline
   * patch), so this is a tidy-up rather than a correctness fix: it shrinks a
   * history.yaml that is rewritten whole on every edit, and gives versions
   * written under the old layout the same standalone change-log file that new
   * ones get. Content and hashes are untouched — the same bytes just move.
   *
   * Idempotent. Returns how many entries were externalized.
   */
  async externalizeDiffs(docId: string): Promise<number> {
    const history = await this.storage.readHistory(docId);
    if (!history) return 0;

    let moved = 0;
    for (const entry of history.versions) {
      if (!entry.diff) continue;
      // Write first, drop from history only once the file is safely on disk.
      await this.storage.writeDiff(docId, entry.version, entry.diff);
      delete entry.diff;
      moved += 1;
    }

    if (moved > 0) await this.storage.writeHistory(docId, history);
    return moved;
  }

  /**
   * Get version history for a document.
   */
  async getHistory(docId: string): Promise<DocumentHistory | null> {
    return this.storage.readHistory(docId);
  }
}
