/**
 * Document version management (§6).
 * Keyframe + diff model with history.yaml tracking.
 */

import { createPatch, applyPatch } from "diff";
import type { ContextNode, DocumentHistory, VersionEntry } from "./types.js";
import { computeContentHash, computeChainHash } from "./integrity.js";
import { serializeDocument } from "./parser.js";
import type { BaseNestStorage } from "./storage/base.js";

const DEFAULT_KEYFRAME_INTERVAL = 10;

export class VersionManager {
  constructor(private storage: BaseNestStorage) {}

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
    const isKeyframe =
      history.versions.length === 0 ||
      currentVersion % history.keyframe_interval === 1 ||
      currentVersion === 1;

    const fullContent = serializeDocument(node);
    const editedAt = new Date().toISOString();

    let contentForHash: string;
    let diff: string | undefined;

    if (isKeyframe) {
      // Write keyframe snapshot
      await this.storage.writeKeyframe(node.id, currentVersion, fullContent);
      contentForHash = fullContent;
    } else {
      // Compute diff from previous version
      const previousContent = await this.reconstructVersion(
        node.id,
        currentVersion - 1,
      );
      diff = createPatch(
        `v${currentVersion - 1}`,
        previousContent,
        fullContent,
        `v${currentVersion - 1}`,
        `v${currentVersion}`,
      );
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
      ...(diff ? { diff } : {}),
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
      throw new Error(`No version history found for ${docId}`);
    }

    // Find the nearest keyframe at or before target version
    let keyframeVersion = -1;
    for (const entry of history.versions) {
      if (entry.keyframe && entry.version <= targetVersion) {
        keyframeVersion = entry.version;
      }
    }

    if (keyframeVersion === -1) {
      throw new Error(
        `No keyframe found at or before version ${targetVersion} for ${docId}`,
      );
    }

    // Read keyframe content
    let content = await this.storage.readKeyframe(docId, keyframeVersion);
    if (content === null) {
      throw new Error(
        `Keyframe file for version ${keyframeVersion} not found for ${docId}`,
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

      if (entry.diff) {
        const result = applyPatch(content, entry.diff);
        if (typeof result === "string") {
          content = result;
        } else if (result === false) {
          throw new Error(
            `Failed to apply diff for version ${entry.version} of ${docId}`,
          );
        }
      }
    }

    return content;
  }

  /**
   * Get version history for a document.
   */
  async getHistory(docId: string): Promise<DocumentHistory | null> {
    return this.storage.readHistory(docId);
  }
}
