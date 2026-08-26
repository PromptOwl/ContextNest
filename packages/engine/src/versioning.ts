/**
 * Document version management (§6).
 * Keyframe + diff model with history.yaml tracking.
 */

import { createPatch, applyPatch } from "diff";
import type { ContextNode, DocumentHistory, VersionEntry } from "./types.js";
import { computeContentHash, computeChainHash } from "./integrity.js";
import { serializeDocument } from "./parser.js";
import { NestStorage } from "./storage.js";
import { ContextNestError, CorruptHistoryError } from "./errors.js";

const DEFAULT_KEYFRAME_INTERVAL = 10;

/** What {@link VersionManager.historyOrRepair} found, and what it had to do. */
export interface ResilientHistory {
  /** The parsed history, or null when there is none to read. */
  history: DocumentHistory | null;
  /**
   * Where an unreadable history.yaml was preserved, when one was moved aside.
   * Null on the normal path — including for a document that simply has no
   * history yet, which is not a break.
   */
  quarantinedAs: string | null;
}

export class VersionManager {
  constructor(private storage: NestStorage) {}

  /**
   * Read a document's history, healing an unreadable one instead of failing the
   * caller's write.
   *
   * A torn history.yaml (an interrupted write leaving null bytes, a hand edit,
   * a schema-invalid file) used to throw `CorruptHistoryError` straight out of
   * every publish and every edit of that document — permanently, with no way
   * for the author to get past it from any surface. The document itself is
   * fine; only its ledger is unreadable. So: move the unreadable file aside
   * (never delete it — it is the sole record of the old chain) and report the
   * document as having no history, which lets {@link createVersion} restart the
   * chain from a fresh keyframe on this very write.
   *
   * Two invariants keep that safe rather than lossy:
   *   - the quarantined bytes stay on disk under `.corrupt-<ts>.yaml`;
   *   - numbering continues past every artifact already sealed on disk (see
   *     {@link nextVersion}), so no `v{N}.md` / `v{N}.diff` is ever reused —
   *     `writeVersionArtifact`'s exclusive create remains the backstop.
   *
   * The break is still visible: `verify` reports the gap, the restart entry
   * carries a note saying what happened, and the quarantined file names it.
   */
  async historyOrRepair(docId: string): Promise<ResilientHistory> {
    try {
      return { history: await this.storage.readHistory(docId), quarantinedAs: null };
    } catch (err) {
      if (!(err instanceof CorruptHistoryError)) throw err;
      const quarantinedAs = await this.storage.quarantineHistory(docId);
      console.warn(
        `[versioning] ${docId}: history.yaml is unreadable (${err.message}); ` +
          `preserved as ${quarantinedAs} and restarting the chain from this version`,
      );
      return { history: null, quarantinedAs };
    }
  }

  /**
   * Next version number for a document — ahead of the caller's hint
   * (frontmatter version, a DB row count), everything recorded in history.yaml,
   * and every version artifact on disk.
   *
   * history.yaml is append-only, so the next entry MUST outrank every entry in
   * it. Numbering from frontmatter alone lets a document whose frontmatter lags
   * its history — a copied/imported vault, a restored backup, a doc whose
   * frontmatter was reset — graft a SECOND chain onto the first: duplicate
   * v{N} entries, keyframe files overwritten at the same number, and
   * reconstructVersion() failing on the first diff after the graft.
   *
   * The on-disk artifacts are consulted too, because a quarantined history
   * (see {@link historyOrRepair}) leaves nothing to read but the `v{N}` files
   * it sealed — and restarting at 1 there would collide with every one of them.
   */
  async nextVersion(docId: string, hint = 0): Promise<number> {
    const { history } = await this.historyOrRepair(docId);
    const recorded = (history?.versions ?? []).reduce(
      (max, entry) => Math.max(max, entry.version),
      0,
    );
    const sealed = await this.storage.maxRecordedVersion(docId);
    return Math.max(hint, recorded, sealed) + 1;
  }

  /**
   * Note for an entry that begins a replacement chain, or null for an ordinary
   * one. Only consulted when there is no readable history, so the directory
   * listing never touches the normal path.
   */
  private async restartNoteFor(
    docId: string,
    history: DocumentHistory | null,
  ): Promise<string | null> {
    if (history) return null;
    const sealed = await this.storage.maxRecordedVersion(docId);
    if (sealed === 0) return null; // genuinely new document, not a restart
    return `Chain restarted — no readable history.yaml, and versions up to v${sealed} were already sealed`;
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
    // Resilient read: an unreadable history is moved aside and treated as
    // absent, so this write restarts the chain rather than failing. See
    // historyOrRepair for why that is safe.
    const { history: readHistory } = await this.historyOrRepair(node.id);
    const history = readHistory || {
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

    // A restart is not a silent event: say so on the entry that begins the new
    // chain, so `ctx history` and the version list show the break where it
    // happened. Detected from what is on disk rather than from the quarantine
    // above, because the two do not always happen in the same call — the
    // publish path repairs first and records the version later, by which point
    // history.yaml is legitimately absent. "No readable ledger, but sealed
    // artifacts above it" is a restart however the ledger came to be missing.
    const note =
      [options.note, await this.restartNoteFor(node.id, readHistory)]
        .filter(Boolean)
        .join(" — ") || undefined;

    const entry: VersionEntry = {
      version: currentVersion,
      ...(isKeyframe ? { keyframe: true } : {}),
      edited_by: editedBy,
      edited_at: editedAt,
      ...(options.publishedAt ? { published_at: options.publishedAt } : {}),
      ...(note ? { note } : {}),
      content_hash: contentHash,
      chain_hash: chainHash,
    };

    // APPEND, never rewrite. The entries already on disk are not reopened for
    // writing, so recording a new version cannot drop an old one no matter what
    // this function got back from the read above.
    await this.storage.appendVersionEntry(
      node.id,
      entry,
      history.keyframe_interval,
    );

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

    // The walk below starts at the nearest keyframe at or before the target and
    // replays diffs forward. Ask for a version the history does not contain and
    // there are no diffs to replay, so it returns the keyframe's content as
    // though it were the version requested — a silently wrong answer in the one
    // place that must never give one. Refuse instead.
    if (!history.versions.some((entry) => entry.version === targetVersion)) {
      throw new ContextNestError(
        `Version ${targetVersion} not found for ${docId}`,
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
    // Deliberate re-anchor: this version is unreconstructable as-is, so its
    // artifact is replaced and the entry re-hashed below. The only path allowed
    // to rewrite a sealed artifact besides externalizeDiffs.
    await this.storage.writeKeyframe(docId, latest.version, fullContent, {
      overwrite: true,
    });

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
      // Idempotent by design — re-running writes the same bytes over an already
      // externalized file, so this one opts out of the immutability guard.
      await this.storage.writeDiff(docId, entry.version, entry.diff, {
        overwrite: true,
      });
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
