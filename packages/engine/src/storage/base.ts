/**
 * Abstract storage backend contract for Context Nest.
 *
 * The engine's domain logic (publish, hygienist, GraphQueryEngine, etc.)
 * operates against this abstract interface — not against a concrete file /
 * MongoDB / GCS implementation. Concrete backends:
 *
 *   - `NestStorage`        — filesystem (`./file.js`). Default.
 *   - `MongoNestStorage`   — MongoDB (`./mongo.js`).
 *   - `GcsNestStorage`     — Google Cloud Storage (`./gcs.js`, stub).
 *
 * Adding a new backend means subclassing `BaseNestStorage` and implementing
 * every abstract method. The engine never branches on backend type.
 */

import type { detectDrift } from "../integrity.js";
import type {
  ContextNode,
  NestConfig,
  DocumentHistory,
  CheckpointHistory,
  Pack,
  ContextYaml,
  VerificationReport,
} from "../types.js";

/** Sentinel suggestion_id used before a drift has been staged into `_suggestions/`. */
export const UNSTAGED_DRIFT_SENTINEL = "unstaged-drift";

/** Vault layout mode. Cloud backends always report `"structured"`. */
export type LayoutMode = "structured" | "obsidian";

/** Options for `BaseNestStorage.readDocument`. */
export interface ReadDocumentOptions {
  /**
   * When true, recompute the body hash and compare against the stored
   * frontmatter checksum (bridge-function-spec Story 3.1, Story 2.1).
   *
   * On drift, the returned `ContextNode` carries last-approved canonical
   * content (when a keyframe exists) plus a `pendingChange` field. The
   * canonical bytes on the backend are never mutated by this read.
   *
   * Default: false (backward compatible — raw parsed bytes).
   */
  verifyChecksum?: boolean;
}

/**
 * Abstract storage backend. Every method MUST be implemented by a concrete
 * subclass — there are no shared default implementations on the base. This
 * keeps the contract obvious for backend authors and avoids accidental
 * filesystem behavior leaking into a cloud backend via inheritance.
 *
 * Method groups:
 *   - Layout + discovery: `detectLayout`, `discoverDocuments`
 *   - Documents: `readDocument`, `readDocuments`, `writeDocument`,
 *                `deleteDocument`, `detectDocumentDrift`
 *   - Derived index: `regenerateIndex`, `readContextYaml`,
 *                    `writeContextYaml`, `writeIndexMd`
 *   - Vault identity: `readContextMd`, `writeContextMd`,
 *                     `readConfig`, `writeConfig`
 *   - Version history: `readHistory`, `writeHistory`,
 *                      `readKeyframe`, `writeKeyframe`,
 *                      `readLatestApprovedKeyframe`, `findAllHistories`
 *   - Checkpoints: `readCheckpointHistory`, `writeCheckpointHistory`
 *   - Drift suggestions: `writeSuggestionPatch`, `writeSuggestionMeta`,
 *                        `readSuggestionPatch`, `readSuggestionMeta`,
 *                        `listSuggestionIds`, `archiveSuggestion`
 *   - Chain events: `readChainEventLog`, `appendChainEvent`
 *   - Packs: `readPacks`
 *   - Integrity audit: `verifyVaultIntegrity`
 *   - Bootstrap: `init`
 */
export abstract class BaseNestStorage {
  // ─── Layout + discovery ──────────────────────────────────────────────

  abstract detectLayout(): Promise<LayoutMode>;

  /**
   * List documents in the vault.
   * By default excludes docs with `status: rejected`.
   * Pass `includeRetired: true` for audit paths. `includeSuperseded` is a
   * deprecated alias for the same flag.
   */
  abstract discoverDocuments(
    options?: { includeRetired?: boolean; includeSuperseded?: boolean },
  ): Promise<ContextNode[]>;

  // ─── Documents ───────────────────────────────────────────────────────

  abstract readDocument(
    id: string,
    options?: ReadDocumentOptions,
  ): Promise<ContextNode>;

  abstract readDocuments(ids: string[]): Promise<Map<string, ContextNode>>;

  abstract writeDocument(id: string, content: string): Promise<void>;

  abstract deleteDocument(id: string): Promise<void>;

  /**
   * Compute drift for a document without mutating canonical bytes.
   * Returns `null` when the document does not exist.
   */
  abstract detectDocumentDrift(
    id: string,
  ): Promise<ReturnType<typeof detectDrift> | null>;

  // ─── Derived index ───────────────────────────────────────────────────

  /**
   * Regenerate all derived artifacts after a mutation:
   *   - `context.yaml` (filtered to published only)
   *   - per-folder `INDEX.md` (includes all statuses for steward visibility)
   *   - agent-config files (CLAUDE.md, GEMINI.md, etc.)
   *
   * Cloud backends may persist these inside a single vault record instead
   * of separate files.
   */
  abstract regenerateIndex(): Promise<void>;

  abstract readContextYaml(): Promise<ContextYaml | null>;
  abstract writeContextYaml(data: ContextYaml): Promise<void>;
  abstract writeIndexMd(folder: string, content: string): Promise<void>;

  // ─── Vault identity ──────────────────────────────────────────────────

  abstract readContextMd(): Promise<string | null>;
  abstract writeContextMd(content: string): Promise<void>;
  abstract readConfig(): Promise<NestConfig | null>;
  abstract writeConfig(config: NestConfig): Promise<void>;

  // ─── Version history ─────────────────────────────────────────────────

  abstract readHistory(docId: string): Promise<DocumentHistory | null>;
  abstract writeHistory(docId: string, history: DocumentHistory): Promise<void>;
  abstract readKeyframe(docId: string, version: number): Promise<string | null>;
  abstract writeKeyframe(
    docId: string,
    version: number,
    content: string,
  ): Promise<void>;

  /**
   * Return the most recent keyframe content for a document, if any.
   * Returns `null` for docs with no history or no keyframes.
   */
  abstract readLatestApprovedKeyframe(
    id: string,
  ): Promise<{ version: number; content: string } | null>;

  /** Return all per-document history records keyed by document id. */
  abstract findAllHistories(): Promise<Map<string, DocumentHistory>>;

  // ─── Checkpoints ─────────────────────────────────────────────────────

  abstract readCheckpointHistory(): Promise<CheckpointHistory | null>;
  abstract writeCheckpointHistory(history: CheckpointHistory): Promise<void>;

  // ─── Drift suggestions ───────────────────────────────────────────────

  abstract writeSuggestionPatch(
    docId: string,
    suggestionId: string,
    patch: string,
  ): Promise<string>;

  abstract writeSuggestionMeta(
    docId: string,
    suggestionId: string,
    meta: unknown,
  ): Promise<string>;

  abstract readSuggestionPatch(
    docId: string,
    suggestionId: string,
  ): Promise<string | null>;

  abstract readSuggestionMeta(
    docId: string,
    suggestionId: string,
  ): Promise<unknown | null>;

  abstract listSuggestionIds(docId: string): Promise<string[]>;

  abstract archiveSuggestion(
    docId: string,
    suggestionId: string,
    kind: "approved" | "rejected",
  ): Promise<string>;

  // ─── Chain events ────────────────────────────────────────────────────

  abstract readChainEventLog(): Promise<unknown[]>;
  abstract appendChainEvent(event: unknown): Promise<void>;

  // ─── Packs ───────────────────────────────────────────────────────────

  abstract readPacks(): Promise<Pack[]>;

  // ─── Integrity audit ─────────────────────────────────────────────────

  abstract verifyVaultIntegrity(): Promise<VerificationReport>;

  // ─── Bootstrap ───────────────────────────────────────────────────────

  /** Initialize a fresh vault with the given name and layout. */
  abstract init(name: string, layout?: LayoutMode): Promise<void>;
}
