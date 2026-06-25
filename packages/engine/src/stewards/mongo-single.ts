/**
 * MongoDB-backed steward store with one row per (scope, target, user).
 * Matches the contextnest-community canonical shape.
 *
 * Schema (override collection name via `config.collection`):
 *
 *   stewards { _id: string, nestId, scope, documentId?, tagName?,
 *              userEmail, userId?, role, assignedBy, assignedAt, isActive }
 *
 * Indexes recommended by the consumer:
 *   { nestId: 1, isActive: 1 }
 *   { nestId: 1, scope: 1, documentId: 1 }
 *   { nestId: 1, scope: 1, tagName: 1 }
 *   partial unique on (nestId, scope, documentId|tagName, userEmail) where
 *     isActive = true — prevents duplicate active grants for the same user.
 *
 * Engine never creates these indexes itself — consumers manage their own
 * Mongo schema. The store reads from / writes to whatever collection it's
 * pointed at.
 */

import { randomUUID } from "node:crypto";
import { BaseStewardStore } from "./base.js";
import type {
  SingleUserSteward,
  StewardRole,
  StewardshipScope,
  ResolvedStewardEntry,
  ResolveStewardsInput,
} from "./types.js";

interface MongoCollection {
  findOne(filter: unknown, options?: unknown): Promise<any>;
  find(filter?: unknown, options?: unknown): { toArray(): Promise<any[]> };
  insertOne(doc: unknown, options?: unknown): Promise<unknown>;
  updateOne(filter: unknown, update: unknown, options?: unknown): Promise<unknown>;
  deleteOne(filter: unknown, options?: unknown): Promise<{ deletedCount?: number }>;
  deleteMany(filter: unknown, options?: unknown): Promise<unknown>;
}
interface MongoDb {
  collection(name: string): MongoCollection;
}

export interface SingleUserStewardStoreConfig {
  /** A connected `Db` from `new MongoClient(uri).db("name")`. */
  db: unknown;
  /** Collection name override. Defaults to `"stewards"`. */
  collection?: string;
}

export interface AssignSingleUserStewardInput {
  nestId: string;
  scope: StewardshipScope;
  documentId?: string;
  tagName?: string;
  userEmail: string;
  userId?: string;
  role: StewardRole;
  assignedBy: string;
}

export interface UpdateSingleUserStewardInput {
  role?: StewardRole;
  /** Re-scope the row. When omitted, scope + target are left unchanged. */
  scope?: StewardshipScope;
  documentId?: string;
  tagName?: string;
}

export interface ListSingleUserStewardsInput {
  scope?: StewardshipScope;
  /** Substring match on `userEmail`, `documentId`, or `tagName`. */
  search?: string;
}

export class SingleUserStewardStore extends BaseStewardStore {
  private readonly db: MongoDb;
  private readonly col: string;

  constructor(config: SingleUserStewardStoreConfig) {
    super();
    if (!config?.db) {
      throw new Error(
        "SingleUserStewardStore: `config.db` is required — pass a connected `mongodb.Db` instance.",
      );
    }
    this.db = config.db as MongoDb;
    this.col = config.collection ?? "stewards";
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  async assignSteward(
    input: AssignSingleUserStewardInput,
  ): Promise<SingleUserSteward> {
    validateScopeTarget(input.scope, input.documentId, input.tagName);
    const email = input.userEmail.trim().toLowerCase();
    const tagName = input.tagName
      ? input.tagName.trim().replace(/^#+/, "").toLowerCase()
      : undefined;

    const row: SingleUserSteward = {
      id: randomUUID(),
      nestId: input.nestId,
      scope: input.scope,
      documentId: input.scope === "document" ? input.documentId : undefined,
      tagName: input.scope === "tag" ? tagName : undefined,
      userEmail: email,
      userId: input.userId,
      role: input.role,
      assignedBy: input.assignedBy,
      assignedAt: new Date().toISOString(),
      isActive: true,
    };

    await this.db.collection(this.col).insertOne({ _id: row.id, ...row });
    return row;
  }

  async removeSteward(id: string): Promise<void> {
    await this.db.collection(this.col).deleteOne({ _id: id });
  }

  async updateSteward(
    id: string,
    update: UpdateSingleUserStewardInput,
  ): Promise<SingleUserSteward | null> {
    const current = (await this.db
      .collection(this.col)
      .findOne({ _id: id, isActive: true })) as any;
    if (!current) return null;

    const set: Record<string, unknown> = {};
    const unset: Record<string, ""> = {};
    if (update.role) set.role = update.role;

    if (update.scope) {
      validateScopeTarget(update.scope, update.documentId, update.tagName);
      set.scope = update.scope;
      if (update.scope === "document") {
        set.documentId = update.documentId;
        unset.tagName = "";
      } else if (update.scope === "tag") {
        set.tagName = update.tagName!.trim().replace(/^#+/, "").toLowerCase();
        unset.documentId = "";
      } else {
        unset.documentId = "";
        unset.tagName = "";
      }
    }

    const updateDoc: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) updateDoc.$set = set;
    if (Object.keys(unset).length > 0) updateDoc.$unset = unset;
    await this.db.collection(this.col).updateOne({ _id: id }, updateDoc);

    return this.getSteward(id);
  }

  async getSteward(id: string): Promise<SingleUserSteward | null> {
    const row = await this.db.collection(this.col).findOne({ _id: id });
    return row ? toSteward(row) : null;
  }

  async listStewards(
    nestId: string,
    opts: ListSingleUserStewardsInput = {},
  ): Promise<SingleUserSteward[]> {
    const filter: any = { nestId, isActive: true };
    if (opts.scope) filter.scope = opts.scope;
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      filter.$or = [
        { userEmail: { $regex: escapeRegex(needle), $options: "i" } },
        { documentId: { $regex: escapeRegex(needle), $options: "i" } },
        { tagName: { $regex: escapeRegex(needle), $options: "i" } },
      ];
    }
    const rows = await this.db.collection(this.col).find(filter).toArray();
    return rows.map(toSteward);
  }

  /** All distinct active steward rows for a given user across the nest. */
  async getStewardsForUser(
    nestId: string,
    userEmail: string,
  ): Promise<SingleUserSteward[]> {
    const email = userEmail.trim().toLowerCase();
    const rows = await this.db
      .collection(this.col)
      .find({ nestId, isActive: true, userEmail: email })
      .toArray();
    return rows.map(toSteward);
  }

  // ─── Resolution ────────────────────────────────────────────────────────

  async resolveStewards(
    nestId: string,
    input: ResolveStewardsInput = {},
  ): Promise<ResolvedStewardEntry[]> {
    const filter: any = {
      nestId,
      isActive: true,
      $or: [{ scope: "nest" }],
    };
    if (input.nodeId) {
      filter.$or.push({ scope: "document", documentId: input.nodeId });
    }
    const normalizedTags = (input.tags ?? [])
      .map((t) => t.trim().replace(/^#+/, "").toLowerCase())
      .filter(Boolean);
    if (normalizedTags.length > 0) {
      filter.$or.push({ scope: "tag", tagName: { $in: normalizedTags } });
    }

    const rows = await this.db.collection(this.col).find(filter).toArray();
    const resolved: ResolvedStewardEntry[] = rows.map((raw: any) => {
      const row = toSteward(raw);
      return {
        email: row.userEmail,
        userId: row.userId,
        role: row.role,
        scope: row.scope,
        priority: priorityFor(row.scope),
        source: sourceFor(row.scope, row.documentId, row.tagName),
        via: "user" as const,
      };
    });

    return resolved.sort((a, b) =>
      a.priority - b.priority ||
      (a.email ?? "").localeCompare(b.email ?? ""),
    );
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function validateScopeTarget(
  scope: StewardshipScope,
  documentId?: string,
  tagName?: string,
): void {
  if (scope === "document" && !documentId) {
    throw new Error("documentId required for document scope");
  }
  if (scope === "tag" && !tagName) {
    throw new Error("tagName required for tag scope");
  }
}

function toSteward(raw: any): SingleUserSteward {
  return {
    id: String(raw._id ?? raw.id),
    nestId: raw.nestId,
    scope: raw.scope,
    documentId: raw.documentId ?? undefined,
    tagName: raw.tagName ?? undefined,
    userEmail: raw.userEmail,
    userId: raw.userId ?? undefined,
    role: raw.role,
    assignedBy: raw.assignedBy,
    assignedAt: raw.assignedAt,
    isActive: !!raw.isActive,
  };
}

function priorityFor(scope: StewardshipScope): number {
  return scope === "document" ? 1 : scope === "tag" ? 2 : 3;
}

function sourceFor(
  scope: StewardshipScope,
  documentId?: string,
  tagName?: string,
): string {
  if (scope === "document") return `document: ${documentId}`;
  if (scope === "tag") return `tag: ${tagName}`;
  return "nest";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
