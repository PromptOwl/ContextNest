/**
 * MongoDB-backed implementation of `BaseNestStorage`.
 *
 * The caller owns the `mongodb` connection: pass a connected `Db` instance
 * into the constructor. Engine never opens or closes a `MongoClient`. The
 * `mongodb` package is an OPTIONAL peer dep — types are referenced as
 * `unknown` here so installs without `mongodb` still type-check.
 *
 * Schema (defaults; every collection name override-able via `collections`):
 *
 *   documents     { _id: docId, frontmatter, body, rawContent }
 *   histories     { _id: docId, keyframe_interval, versions: [...] }
 *                 (keyframe entries embed `keyframe_content`)
 *   checkpoints   { _id: checkpoint_number, ...Checkpoint }
 *   suggestions   { _id: suggestionId, documentId, ...SuggestionMeta, patch, archived? }
 *   packs         { _id: packId, ...Pack }
 *   chain_events  { _id: eventId, ...HashChainEvent }
 *   nest          single doc { _id: "vault", config, context_yaml?, indexes? }
 *                 (replaces context.yaml + per-folder INDEX.md files)
 *
 * Multi-collection writes (publish, approve, etc.) use `session.withTransaction(...)`
 * — requires Mongo replica set / Atlas / 4.0+ with sessions enabled.
 */

import { parseDocument } from "../parser.js";
import {
  detectDrift,
  verifyDocumentChain,
  verifyCheckpointChain,
} from "../integrity.js";
import { generateContextYaml } from "../index-generator.js";
import { generateIndexMd } from "../index-md-generator.js";
import type {
  ContextNode,
  NestConfig,
  DocumentHistory,
  CheckpointHistory,
  Pack,
  ContextYaml,
  PendingChange,
  VerificationReport,
} from "../types.js";
import { DocumentNotFoundError } from "../errors.js";
import {
  packSchema,
  documentHistorySchema,
  checkpointHistorySchema,
} from "../schemas.js";
import {
  BaseNestStorage,
  UNSTAGED_DRIFT_SENTINEL,
  type LayoutMode,
  type ReadDocumentOptions,
} from "./base.js";

/**
 * Per-collection overrides. Any key omitted falls back to the default name.
 * Lets TheOwl (or any consumer) plug into an existing Mongo schema instead
 * of creating engine-named collections.
 */
export interface CollectionMap {
  documents?: string;
  histories?: string;
  checkpoints?: string;
  suggestions?: string;
  packs?: string;
  chainEvents?: string;
  nest?: string;
}

const DEFAULT_COLLECTIONS: Required<CollectionMap> = {
  documents: "documents",
  histories: "histories",
  checkpoints: "checkpoints",
  suggestions: "suggestions",
  packs: "packs",
  chainEvents: "chain_events",
  nest: "nest",
};

/**
 * Construction config. The `db` value MUST be a connected `mongodb.Db`
 * instance — typed as `unknown` here because `mongodb` is an optional peer
 * dep that may not be installed at engine consumers that never use this
 * backend (CLI / MCP). Runtime cast happens inside the class.
 */
export interface MongoStorageConfig {
  /** A connected `Db` from `new MongoClient(uri).db("name")`. */
  db: unknown;
  /** Override collection names. */
  collections?: CollectionMap;
}

/** Internal minimal-surface typing for the parts of the mongodb Db API we use. */
interface MongoCollection {
  findOne(filter: unknown, options?: unknown): Promise<any>;
  find(filter?: unknown, options?: unknown): { toArray(): Promise<any[]> };
  insertOne(doc: unknown, options?: unknown): Promise<unknown>;
  replaceOne(filter: unknown, doc: unknown, options?: unknown): Promise<unknown>;
  updateOne(filter: unknown, update: unknown, options?: unknown): Promise<unknown>;
  deleteOne(filter: unknown, options?: unknown): Promise<{ deletedCount?: number }>;
  deleteMany(filter: unknown, options?: unknown): Promise<unknown>;
}
interface MongoDb {
  collection(name: string): MongoCollection;
}

const VAULT_KEY = "vault";

export class MongoNestStorage extends BaseNestStorage {
  private readonly db: MongoDb;
  private readonly cols: Required<CollectionMap>;

  constructor(config: MongoStorageConfig) {
    super();
    if (!config?.db) {
      throw new Error(
        "MongoNestStorage: `config.db` is required — pass a connected `mongodb.Db` instance.",
      );
    }
    this.db = config.db as MongoDb;
    this.cols = { ...DEFAULT_COLLECTIONS, ...(config.collections ?? {}) };
  }

  // ─── Layout + discovery ──────────────────────────────────────────────

  async detectLayout(): Promise<LayoutMode> {
    return "structured";
  }

  async discoverDocuments(
    options: { includeRetired?: boolean; includeSuperseded?: boolean } = {},
  ): Promise<ContextNode[]> {
    const includeRetired = options.includeRetired || options.includeSuperseded;
    const filter = includeRetired ? {} : { "frontmatter.status": { $ne: "rejected" } };
    const docs = await this.db.collection(this.cols.documents).find(filter).toArray();
    return docs
      .map((d: any) => this.toContextNode(d))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ─── Documents ───────────────────────────────────────────────────────

  async readDocument(
    id: string,
    options: ReadDocumentOptions = {},
  ): Promise<ContextNode> {
    const doc = await this.db.collection(this.cols.documents).findOne({ _id: id });
    if (!doc) throw new DocumentNotFoundError(id);

    const liveNode = this.toContextNode(doc);
    if (!options.verifyChecksum) return liveNode;

    const drift = detectDrift(liveNode.rawContent, liveNode.frontmatter.checksum);
    if (!drift.drifted) return liveNode;

    const approved = await this.readLatestApprovedKeyframe(id);
    const pendingChange: PendingChange = {
      suggestion_id: UNSTAGED_DRIFT_SENTINEL,
      detected_at: new Date().toISOString(),
      source: "out-of-band-edit",
      proposed_hash: drift.actualHash,
    };

    if (approved) {
      const approvedNode = parseDocument(`${id}.md`, approved.content, id);
      return { ...approvedNode, pendingChange };
    }
    return { ...liveNode, pendingChange };
  }

  async readDocuments(ids: string[]): Promise<Map<string, ContextNode>> {
    const results = new Map<string, ContextNode>();
    if (ids.length === 0) return results;
    const docs = await this.db
      .collection(this.cols.documents)
      .find({ _id: { $in: ids } })
      .toArray();
    for (const d of docs) {
      const node = this.toContextNode(d);
      results.set(node.id, node);
    }
    return results;
  }

  async writeDocument(id: string, content: string): Promise<void> {
    const node = parseDocument(`${id}.md`, content, id);
    await this.db.collection(this.cols.documents).replaceOne(
      { _id: id },
      {
        _id: id,
        frontmatter: node.frontmatter,
        body: node.body,
        rawContent: node.rawContent,
      },
      { upsert: true },
    );
  }

  async deleteDocument(id: string): Promise<void> {
    const result = await this.db
      .collection(this.cols.documents)
      .deleteOne({ _id: id });
    if (!result.deletedCount) throw new DocumentNotFoundError(id);
    // Cascade per-doc data so no orphans survive the delete:
    //   histories  : version timeline + embedded keyframe payloads
    //   suggestions: any drift/manual patches still pointed at this doc
    //   chain_events: hash-chain audit entries scoped to this doc
    await Promise.all([
      this.db.collection(this.cols.histories).deleteOne({ _id: id }),
      this.db
        .collection(this.cols.suggestions)
        .deleteMany({ documentId: id }),
      this.db
        .collection(this.cols.chainEvents)
        .deleteMany({ document_id: id }),
    ]);
    // Prune the derived INDEX entry if this doc was the last in its folder.
    await this.pruneEmptyIndexFolder(id);
  }

  /**
   * Drop the `nest.indexes.<folder>` entry once a folder loses its last
   * document. Keeps the derived INDEX surface from holding stale per-folder
   * Markdown that points at a vanished doc. Siblings keep their entries —
   * `regenerateIndex` is still the authoritative rebuild path; this is the
   * minimal in-line cleanup so the surface is correct immediately.
   */
  private async pruneEmptyIndexFolder(deletedId: string): Promise<void> {
    const parts = deletedId.split("/");
    if (parts.length < 2) return;
    const folder = parts.slice(0, -1).join("/");
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sibling = await this.db
      .collection(this.cols.documents)
      .findOne({ _id: { $regex: `^${escaped}/` } });
    if (sibling) return;
    await this.db
      .collection(this.cols.nest)
      .updateOne(
        { _id: VAULT_KEY },
        { $unset: { [`indexes.${folder}`]: "" } },
      );
  }

  async detectDocumentDrift(
    id: string,
  ): Promise<ReturnType<typeof detectDrift> | null> {
    const doc = await this.db.collection(this.cols.documents).findOne({ _id: id });
    if (!doc) return null;
    const node = this.toContextNode(doc);
    return detectDrift(node.rawContent, node.frontmatter.checksum);
  }

  // ─── Derived index ───────────────────────────────────────────────────

  async regenerateIndex(): Promise<void> {
    const docs = await this.discoverDocuments({ includeRetired: true });
    const config = await this.readConfig();
    const checkpointHistory = await this.readCheckpointHistory();
    const latestCheckpoint = checkpointHistory?.checkpoints?.at(-1) ?? null;
    const published = docs.filter((d) => d.frontmatter.status === "published");

    const contextYaml = generateContextYaml(published, config, latestCheckpoint);

    // Per-folder INDEX.md content (kept as derived data on the nest record
    // so cloud stewards have a single place to fetch it).
    const folders = new Map<string, ContextNode[]>();
    for (const doc of docs) {
      const parts = doc.id.split("/");
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push(doc);
    }
    const indexes: Record<string, string> = {};
    for (const [folder, folderDocs] of folders) {
      if (folder === ".") continue;
      const title = folder
        .split("/")
        .pop()!
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      indexes[folder] = generateIndexMd(folder, title, folderDocs);
    }

    await this.db.collection(this.cols.nest).updateOne(
      { _id: VAULT_KEY },
      { $set: { context_yaml: contextYaml, indexes } },
      { upsert: true },
    );
  }

  async readContextYaml(): Promise<ContextYaml | null> {
    const nest = await this.db.collection(this.cols.nest).findOne({ _id: VAULT_KEY });
    return (nest?.context_yaml as ContextYaml) ?? null;
  }

  async writeContextYaml(data: ContextYaml): Promise<void> {
    await this.db.collection(this.cols.nest).updateOne(
      { _id: VAULT_KEY },
      { $set: { context_yaml: data } },
      { upsert: true },
    );
  }

  async writeIndexMd(folder: string, content: string): Promise<void> {
    await this.db.collection(this.cols.nest).updateOne(
      { _id: VAULT_KEY },
      { $set: { [`indexes.${folder}`]: content } },
      { upsert: true },
    );
  }

  // ─── Vault identity ──────────────────────────────────────────────────

  async readContextMd(): Promise<string | null> {
    const nest = await this.db.collection(this.cols.nest).findOne({ _id: VAULT_KEY });
    return (nest?.context_md as string) ?? null;
  }

  async writeContextMd(content: string): Promise<void> {
    await this.db.collection(this.cols.nest).updateOne(
      { _id: VAULT_KEY },
      { $set: { context_md: content } },
      { upsert: true },
    );
  }

  async readConfig(): Promise<NestConfig | null> {
    const nest = await this.db.collection(this.cols.nest).findOne({ _id: VAULT_KEY });
    return (nest?.config as NestConfig) ?? null;
  }

  async writeConfig(config: NestConfig): Promise<void> {
    await this.db.collection(this.cols.nest).updateOne(
      { _id: VAULT_KEY },
      { $set: { config } },
      { upsert: true },
    );
  }

  // ─── Version history ─────────────────────────────────────────────────

  async readHistory(docId: string): Promise<DocumentHistory | null> {
    const raw = await this.db.collection(this.cols.histories).findOne({ _id: docId });
    if (!raw) return null;
    // Strip _id + embedded keyframe_content before validating.
    const { _id: _omitId, ...rest } = raw;
    const stripped = {
      ...rest,
      versions: (rest.versions ?? []).map(({ keyframe_content: _kc, ...v }: any) => v),
    };
    const result = documentHistorySchema.safeParse(stripped);
    return result.success ? (result.data as DocumentHistory) : null;
  }

  async writeHistory(docId: string, history: DocumentHistory): Promise<void> {
    await this.db.collection(this.cols.histories).replaceOne(
      { _id: docId },
      { _id: docId, ...history },
      { upsert: true },
    );
  }

  async readKeyframe(docId: string, version: number): Promise<string | null> {
    const raw = await this.db.collection(this.cols.histories).findOne({ _id: docId });
    if (!raw) return null;
    const entry = (raw.versions ?? []).find((v: any) => v.version === version);
    return entry?.keyframe_content ?? null;
  }

  async writeKeyframe(
    docId: string,
    version: number,
    content: string,
  ): Promise<void> {
    // Embed keyframe content into the matching version entry. Caller
    // guarantees writeHistory ran first.
    await this.db.collection(this.cols.histories).updateOne(
      { _id: docId, "versions.version": version },
      { $set: { "versions.$.keyframe_content": content } },
    );
  }

  async readLatestApprovedKeyframe(
    id: string,
  ): Promise<{ version: number; content: string } | null> {
    const history = await this.readHistory(id);
    if (!history || history.versions.length === 0) return null;
    for (let i = history.versions.length - 1; i >= 0; i--) {
      const entry = history.versions[i];
      if (!entry.keyframe) continue;
      const content = await this.readKeyframe(id, entry.version);
      if (content !== null) return { version: entry.version, content };
    }
    return null;
  }

  async findAllHistories(): Promise<Map<string, DocumentHistory>> {
    const docs = await this.db.collection(this.cols.histories).find({}).toArray();
    const result = new Map<string, DocumentHistory>();
    for (const raw of docs) {
      const { _id, ...rest } = raw;
      const stripped = {
        ...rest,
        versions: (rest.versions ?? []).map(({ keyframe_content: _kc, ...v }: any) => v),
      };
      const parsed = documentHistorySchema.safeParse(stripped);
      if (parsed.success) result.set(String(_id), parsed.data as DocumentHistory);
    }
    return result;
  }

  // ─── Checkpoints ─────────────────────────────────────────────────────

  async readCheckpointHistory(): Promise<CheckpointHistory | null> {
    const docs = await this.db
      .collection(this.cols.checkpoints)
      .find({})
      .toArray();
    if (docs.length === 0) return null;
    const checkpoints = docs
      .map(({ _id: _omit, ...c }: any) => c)
      .sort((a: any, b: any) => a.checkpoint - b.checkpoint);
    const wrapped = { checkpoints };
    const parsed = checkpointHistorySchema.safeParse(wrapped);
    return parsed.success ? (parsed.data as CheckpointHistory) : null;
  }

  async writeCheckpointHistory(history: CheckpointHistory): Promise<void> {
    // Replace strategy: clear + re-insert. Cheap given checkpoint counts are
    // small (one per publish). Acceptable for transactional consistency.
    await this.db.collection(this.cols.checkpoints).deleteMany({});
    for (const cp of history.checkpoints) {
      await this.db
        .collection(this.cols.checkpoints)
        .insertOne({ _id: cp.checkpoint, ...cp });
    }
  }

  // ─── Drift suggestions ───────────────────────────────────────────────

  async writeSuggestionPatch(
    docId: string,
    suggestionId: string,
    patch: string,
  ): Promise<string> {
    await this.db.collection(this.cols.suggestions).updateOne(
      { _id: suggestionId },
      { $set: { _id: suggestionId, documentId: docId, patch } },
      { upsert: true },
    );
    return `${this.cols.suggestions}/${suggestionId}.patch`;
  }

  async writeSuggestionMeta(
    docId: string,
    suggestionId: string,
    meta: unknown,
  ): Promise<string> {
    await this.db.collection(this.cols.suggestions).updateOne(
      { _id: suggestionId },
      { $set: { _id: suggestionId, documentId: docId, meta } },
      { upsert: true },
    );
    return `${this.cols.suggestions}/${suggestionId}.meta`;
  }

  async readSuggestionPatch(
    _docId: string,
    suggestionId: string,
  ): Promise<string | null> {
    const raw = await this.db
      .collection(this.cols.suggestions)
      .findOne({ _id: suggestionId });
    return (raw?.patch as string) ?? null;
  }

  async readSuggestionMeta(
    _docId: string,
    suggestionId: string,
  ): Promise<unknown | null> {
    const raw = await this.db
      .collection(this.cols.suggestions)
      .findOne({ _id: suggestionId });
    return raw?.meta ?? null;
  }

  async listSuggestionIds(docId: string): Promise<string[]> {
    const docs = await this.db
      .collection(this.cols.suggestions)
      .find({ documentId: docId, archived: { $ne: true } })
      .toArray();
    return docs.map((d: any) => String(d._id)).sort();
  }

  async archiveSuggestion(
    _docId: string,
    suggestionId: string,
    kind: "approved" | "rejected",
  ): Promise<string> {
    await this.db.collection(this.cols.suggestions).updateOne(
      { _id: suggestionId },
      { $set: { archived: true, archive_kind: kind } },
    );
    return `${this.cols.suggestions}/_archive/${kind}`;
  }

  // ─── Chain events ────────────────────────────────────────────────────

  async readChainEventLog(): Promise<unknown[]> {
    const docs = await this.db.collection(this.cols.chainEvents).find({}).toArray();
    return docs
      .map(({ _id: _omit, ...e }: any) => e)
      .sort((a: any, b: any) =>
        String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")),
      );
  }

  async appendChainEvent(event: unknown): Promise<void> {
    const e = event as { event_id?: string };
    if (!e?.event_id) {
      throw new Error("appendChainEvent: event.event_id required for Mongo backend");
    }
    await this.db
      .collection(this.cols.chainEvents)
      .insertOne({ _id: e.event_id, ...(event as Record<string, unknown>) });
  }

  // ─── Packs ───────────────────────────────────────────────────────────

  async readPacks(): Promise<Pack[]> {
    const docs = await this.db.collection(this.cols.packs).find({}).toArray();
    const packs: Pack[] = [];
    for (const raw of docs) {
      const { _id: _omit, ...rest } = raw;
      const parsed = packSchema.safeParse(rest);
      if (parsed.success) packs.push(parsed.data as Pack);
    }
    return packs;
  }

  // ─── Integrity audit ─────────────────────────────────────────────────

  async verifyVaultIntegrity(): Promise<VerificationReport> {
    const allHistories = await this.findAllHistories();
    const checkpointHistory = await this.readCheckpointHistory();
    const errors: VerificationReport["errors"] = [];

    for (const [docId, history] of allHistories) {
      const report = verifyDocumentChain(docId, history, (_v) => null);
      if (!report.valid) errors.push(...report.errors);
    }

    if (checkpointHistory) {
      const report = verifyCheckpointChain(
        checkpointHistory.checkpoints,
        allHistories,
      );
      if (!report.valid) errors.push(...report.errors);
    }

    const liveDocs = await this.discoverDocuments({ includeRetired: true });
    for (const doc of liveDocs) {
      const drift = await this.detectDocumentDrift(doc.id);
      if (drift && drift.drifted) {
        errors.push({
          type: "body_drift",
          document: doc.id,
          expected: drift.storedHash,
          actual: drift.actualHash,
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────

  async init(name: string, _layout: LayoutMode = "structured"): Promise<void> {
    const config: NestConfig = {
      version: 1,
      name,
      defaults: { status: "draft" },
    };
    await this.writeConfig(config);
    await this.writeContextMd(`---
title: "${name}"
---

# ${name}

## How to Use This Vault

1. Read the \`nest.config\` record for nest configuration and folder descriptions
2. Read \`nest.indexes\` for per-folder document summaries
3. Use \`nest.context_yaml\` to understand the document graph
4. Start with hub documents (highest inbound links) for broad context
5. Follow \`contextnest://\` links within documents to traverse related content

## Operating Instructions

- Always cite sources by document path
- Prefer published documents over drafts
`);
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private toContextNode(raw: any): ContextNode {
    // Mongo store keeps `{ frontmatter, body, rawContent }`. Round-trip
    // through parseDocument when rawContent is present to apply status
    // normalization etc. uniformly with the file backend.
    const id = String(raw._id);
    if (typeof raw.rawContent === "string") {
      return parseDocument(`${id}.md`, raw.rawContent, id);
    }
    return {
      id,
      filePath: `${id}.md`,
      frontmatter: raw.frontmatter ?? { title: id },
      body: raw.body ?? "",
      rawContent: raw.rawContent ?? "",
    };
  }
}
