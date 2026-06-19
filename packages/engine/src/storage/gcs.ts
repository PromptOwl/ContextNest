/**
 * Google Cloud Storage backend — STUB.
 *
 * Reserves the surface for a GCS-backed implementation. Every method throws
 * `Error("GcsNestStorage: not yet implemented")` so consumers that try to
 * use it get a clear, actionable failure instead of silently undefined
 * behavior. The class extends `BaseNestStorage` so type-hints across the
 * engine continue to accept a GCS instance once the methods are filled in.
 *
 * Tracked as a follow-up implementation ticket. Schema design when shipped:
 * object keys mirror the file layout (`<prefix>/nodes/<id>.md`,
 * `<prefix>/_history/<docId>/history.yaml`, ...). No multi-key atomicity —
 * GCS object writes are per-key atomic only. Existing hash chain / drift
 * tooling catches partial-failure inconsistency.
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
import {
  BaseNestStorage,
  type LayoutMode,
  type ReadDocumentOptions,
} from "./base.js";

/**
 * Construction config. Bucket reference + optional key prefix + optional
 * flag controlling whether derived index data (`context.yaml`, per-folder
 * `INDEX.md`) is persisted as objects.
 *
 * `bucket` is typed `unknown` because `@google-cloud/storage` is an optional
 * peer dep that may not be installed.
 */
export interface GcsStorageConfig {
  /** A connected `Bucket` from `new Storage().bucket("name")`. */
  bucket: unknown;
  /** Optional key prefix under the bucket (e.g. `"vaults/my-vault"`). */
  prefix?: string;
  /**
   * When true, `regenerateIndex` writes `context.yaml` + per-folder
   * `INDEX.md` as objects under the prefix. When false (default), index
   * data is reconstructed on demand and not persisted.
   */
  persistDerived?: boolean;
}

const NOT_IMPLEMENTED = "GcsNestStorage: not yet implemented";

export class GcsNestStorage extends BaseNestStorage {
  // Reserved for future implementation. Stored on the instance so the
  // surface stabilizes now and the impl PR just fills the method bodies.
  protected readonly bucket: unknown;
  protected readonly prefix: string;
  protected readonly persistDerived: boolean;

  constructor(config: GcsStorageConfig) {
    super();
    if (!config?.bucket) {
      throw new Error(
        "GcsNestStorage: `config.bucket` is required — pass a connected `@google-cloud/storage` Bucket instance.",
      );
    }
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "";
    this.persistDerived = config.persistDerived ?? false;
  }

  async detectLayout(): Promise<LayoutMode> {
    return "structured";
  }

  async discoverDocuments(_options?: {
    includeRetired?: boolean;
    includeSuperseded?: boolean;
  }): Promise<ContextNode[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readDocument(
    _id: string,
    _options?: ReadDocumentOptions,
  ): Promise<ContextNode> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readDocuments(_ids: string[]): Promise<Map<string, ContextNode>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeDocument(_id: string, _content: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async deleteDocument(_id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async detectDocumentDrift(
    _id: string,
  ): Promise<ReturnType<typeof detectDrift> | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async regenerateIndex(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readContextYaml(): Promise<ContextYaml | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeContextYaml(_data: ContextYaml): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeIndexMd(_folder: string, _content: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readContextMd(): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeContextMd(_content: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readConfig(): Promise<NestConfig | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeConfig(_config: NestConfig): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readHistory(_docId: string): Promise<DocumentHistory | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeHistory(
    _docId: string,
    _history: DocumentHistory,
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readKeyframe(
    _docId: string,
    _version: number,
  ): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeKeyframe(
    _docId: string,
    _version: number,
    _content: string,
  ): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readLatestApprovedKeyframe(
    _id: string,
  ): Promise<{ version: number; content: string } | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async findAllHistories(): Promise<Map<string, DocumentHistory>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readCheckpointHistory(): Promise<CheckpointHistory | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeCheckpointHistory(_history: CheckpointHistory): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeSuggestionPatch(
    _docId: string,
    _suggestionId: string,
    _patch: string,
  ): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async writeSuggestionMeta(
    _docId: string,
    _suggestionId: string,
    _meta: unknown,
  ): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readSuggestionPatch(
    _docId: string,
    _suggestionId: string,
  ): Promise<string | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readSuggestionMeta(
    _docId: string,
    _suggestionId: string,
  ): Promise<unknown | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listSuggestionIds(_docId: string): Promise<string[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async archiveSuggestion(
    _docId: string,
    _suggestionId: string,
    _kind: "approved" | "rejected",
  ): Promise<string> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readChainEventLog(): Promise<unknown[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async appendChainEvent(_event: unknown): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async readPacks(): Promise<Pack[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async verifyVaultIntegrity(): Promise<VerificationReport> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async init(_name: string, _layout?: LayoutMode): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
