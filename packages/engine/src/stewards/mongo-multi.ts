/**
 * MongoDB-backed steward store with one row per (scope, target) containing
 * embedded `users[]` + `teams[]` arrays. Matches the PromptOwl TheOwl shape.
 *
 * Schema (override collection name via `config.collection`):
 *
 *   stewards { _id: string, nestId, scope, documentId?, tagName?,
 *              users: [...], teams: [...],
 *              isActive, createdAt, updatedAt }
 *
 * Recommended indexes on the consumer side:
 *   { nestId: 1, isActive: 1 }
 *   { nestId: 1, scope: 1, documentId: 1 }
 *   { nestId: 1, scope: 1, tagName: 1 }
 *   { "users.email": 1 }
 *   { "teams.teamId": 1 }
 *   partial unique on (nestId, scope, documentId|tagName) where isActive = true
 *     so a given scope-target has at most one record.
 *
 * Team membership lookup is the consumer's responsibility: pass the
 * actor's team IDs into `resolveStewards({ teamIds })` and the store will
 * emit team-derived grants alongside direct user grants.
 */

import { randomUUID } from "node:crypto";
import { BaseStewardStore } from "./base.js";
import type {
  MultiUserSteward,
  StewardRole,
  StewardshipScope,
  StewardUserEntry,
  StewardTeamEntry,
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

export interface MultiUserStewardStoreConfig {
  db: unknown;
  collection?: string;
}

export interface ResolveMultiStewardsInput extends ResolveStewardsInput {
  /**
   * Team IDs the actor is a member of. Required for any team-derived grants
   * to surface from `resolveStewards`; if absent, only direct user grants
   * are emitted. Engine has no notion of team membership — the consumer is
   * the authority and supplies the list here.
   */
  teamIds?: string[];
}

export interface CreateMultiStewardInput {
  nestId: string;
  scope: StewardshipScope;
  documentId?: string;
  tagName?: string;
  users?: Array<Omit<StewardUserEntry, "addedAt"> & { addedAt?: string }>;
  teams?: Array<Omit<StewardTeamEntry, "addedAt"> & { addedAt?: string }>;
}

export class MultiUserStewardStore extends BaseStewardStore {
  private readonly db: MongoDb;
  private readonly col: string;

  constructor(config: MultiUserStewardStoreConfig) {
    super();
    if (!config?.db) {
      throw new Error(
        "MultiUserStewardStore: `config.db` is required — pass a connected `mongodb.Db` instance.",
      );
    }
    this.db = config.db as MongoDb;
    this.col = config.collection ?? "stewards";
  }

  // ─── Record CRUD ───────────────────────────────────────────────────────

  /**
   * Create a new steward record for a (scope, target). Throws if one
   * already exists — use `addUser`/`addTeam` to append to an existing
   * record instead.
   */
  async createSteward(input: CreateMultiStewardInput): Promise<MultiUserSteward> {
    validateScopeTarget(input.scope, input.documentId, input.tagName);
    const tagName = input.tagName
      ? input.tagName.trim().replace(/^#+/, "").toLowerCase()
      : undefined;

    const filter = recordFilter(input.nestId, input.scope, input.documentId, tagName);
    const existing = await this.db.collection(this.col).findOne(filter);
    if (existing) {
      throw new Error(
        `Steward record already exists for ${describeTarget(input.scope, input.documentId, tagName)} — use addUser/addTeam instead.`,
      );
    }

    const now = new Date().toISOString();
    const row: MultiUserSteward = {
      id: randomUUID(),
      nestId: input.nestId,
      scope: input.scope,
      documentId: input.scope === "document" ? input.documentId : undefined,
      tagName: input.scope === "tag" ? tagName : undefined,
      users: (input.users ?? []).map((u) => normalizeUser(u, now)),
      teams: (input.teams ?? []).map((t) => normalizeTeam(t, now)),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.collection(this.col).insertOne({ _id: row.id, ...row });
    return row;
  }

  async removeSteward(id: string): Promise<void> {
    await this.db.collection(this.col).deleteOne({ _id: id });
  }

  async getSteward(id: string): Promise<MultiUserSteward | null> {
    const raw = await this.db.collection(this.col).findOne({ _id: id });
    return raw ? toMultiSteward(raw) : null;
  }

  /** Locate the single record for (scope, target). */
  async getStewardForTarget(
    nestId: string,
    scope: StewardshipScope,
    documentId?: string,
    tagName?: string,
  ): Promise<MultiUserSteward | null> {
    validateScopeTarget(scope, documentId, tagName);
    const normalizedTag = tagName
      ? tagName.trim().replace(/^#+/, "").toLowerCase()
      : undefined;
    const filter = recordFilter(nestId, scope, documentId, normalizedTag);
    const raw = await this.db.collection(this.col).findOne(filter);
    return raw ? toMultiSteward(raw) : null;
  }

  async listStewards(
    nestId: string,
    opts: { scope?: StewardshipScope } = {},
  ): Promise<MultiUserSteward[]> {
    const filter: any = { nestId, isActive: true };
    if (opts.scope) filter.scope = opts.scope;
    const rows = await this.db.collection(this.col).find(filter).toArray();
    return rows.map(toMultiSteward);
  }

  // ─── User/team mutations on a record ───────────────────────────────────

  /**
   * Append a user to the record for (scope, target). If no record exists,
   * one is created. If the user is already present, throws — caller can
   * fall back to `updateUserRole`.
   */
  async addUser(
    nestId: string,
    scope: StewardshipScope,
    target: { documentId?: string; tagName?: string },
    user: Omit<StewardUserEntry, "addedAt"> & { addedAt?: string },
  ): Promise<MultiUserSteward> {
    validateScopeTarget(scope, target.documentId, target.tagName);
    const tagName = target.tagName
      ? target.tagName.trim().replace(/^#+/, "").toLowerCase()
      : undefined;
    const normalizedUser = normalizeUser(user, new Date().toISOString());

    let record = await this.getStewardForTarget(
      nestId,
      scope,
      target.documentId,
      tagName,
    );
    if (!record) {
      record = await this.createSteward({
        nestId,
        scope,
        documentId: target.documentId,
        tagName,
        users: [normalizedUser],
      });
      return record;
    }

    if (record.users.some((u) => u.email === normalizedUser.email)) {
      throw new Error(
        `"${normalizedUser.email}" is already on this steward record. Use updateUserRole to change role.`,
      );
    }

    await this.db.collection(this.col).updateOne(
      { _id: record.id },
      {
        $push: { users: normalizedUser },
        $set: { updatedAt: new Date().toISOString() },
      } as any,
    );
    return (await this.getSteward(record.id))!;
  }

  async removeUser(
    recordId: string,
    email: string,
  ): Promise<MultiUserSteward | null> {
    const normalized = email.trim().toLowerCase();
    await this.db.collection(this.col).updateOne(
      { _id: recordId },
      {
        $pull: { users: { email: normalized } },
        $set: { updatedAt: new Date().toISOString() },
      } as any,
    );
    return this.getSteward(recordId);
  }

  async updateUserRole(
    recordId: string,
    email: string,
    role: StewardRole,
  ): Promise<MultiUserSteward | null> {
    const normalized = email.trim().toLowerCase();
    await this.db.collection(this.col).updateOne(
      { _id: recordId, "users.email": normalized },
      {
        $set: {
          "users.$.role": role,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    return this.getSteward(recordId);
  }

  async addTeam(
    nestId: string,
    scope: StewardshipScope,
    target: { documentId?: string; tagName?: string },
    team: Omit<StewardTeamEntry, "addedAt"> & { addedAt?: string },
  ): Promise<MultiUserSteward> {
    validateScopeTarget(scope, target.documentId, target.tagName);
    const tagName = target.tagName
      ? target.tagName.trim().replace(/^#+/, "").toLowerCase()
      : undefined;
    const normalizedTeam = normalizeTeam(team, new Date().toISOString());

    let record = await this.getStewardForTarget(
      nestId,
      scope,
      target.documentId,
      tagName,
    );
    if (!record) {
      record = await this.createSteward({
        nestId,
        scope,
        documentId: target.documentId,
        tagName,
        teams: [normalizedTeam],
      });
      return record;
    }

    if (record.teams.some((t) => t.teamId === normalizedTeam.teamId)) {
      throw new Error(
        `Team "${normalizedTeam.name}" is already on this steward record.`,
      );
    }

    await this.db.collection(this.col).updateOne(
      { _id: record.id },
      {
        $push: { teams: normalizedTeam },
        $set: { updatedAt: new Date().toISOString() },
      } as any,
    );
    return (await this.getSteward(record.id))!;
  }

  async removeTeam(
    recordId: string,
    teamId: string,
  ): Promise<MultiUserSteward | null> {
    await this.db.collection(this.col).updateOne(
      { _id: recordId },
      {
        $pull: { teams: { teamId } },
        $set: { updatedAt: new Date().toISOString() },
      } as any,
    );
    return this.getSteward(recordId);
  }

  // ─── Resolution ────────────────────────────────────────────────────────

  async resolveStewards(
    nestId: string,
    input: ResolveMultiStewardsInput = {},
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
    // Engine has no team-membership knowledge. When the caller does not pass
    // `teamIds`, team grants are intentionally suppressed — caller-as-authority.
    // To opt in, pass the actor's team IDs (empty array is treated the same as
    // "not supplied" — there are no teams the actor belongs to).
    const teamIds = input.teamIds && input.teamIds.length > 0
      ? new Set(input.teamIds)
      : null;
    const resolved: ResolvedStewardEntry[] = [];

    for (const raw of rows) {
      const record = toMultiSteward(raw);
      for (const u of record.users) {
        resolved.push({
          email: u.email,
          userId: u.userId,
          role: u.role,
          scope: record.scope,
          priority: priorityFor(record.scope),
          source: sourceFor(record.scope, record.documentId, record.tagName),
          via: "user",
        });
      }
      if (!teamIds) continue;
      for (const t of record.teams) {
        if (!teamIds.has(t.teamId)) continue;
        resolved.push({
          teamId: t.teamId,
          teamName: t.name,
          role: t.role,
          scope: record.scope,
          priority: priorityFor(record.scope),
          source: sourceFor(record.scope, record.documentId, record.tagName),
          via: "team",
        });
      }
    }

    return resolved.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const aKey = a.email ?? a.teamId ?? "";
      const bKey = b.email ?? b.teamId ?? "";
      return aKey.localeCompare(bKey);
    });
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

function recordFilter(
  nestId: string,
  scope: StewardshipScope,
  documentId?: string,
  tagName?: string,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { nestId, scope, isActive: true };
  if (scope === "document") filter.documentId = documentId;
  if (scope === "tag") filter.tagName = tagName;
  return filter;
}

function describeTarget(
  scope: StewardshipScope,
  documentId?: string,
  tagName?: string,
): string {
  if (scope === "document") return `document "${documentId}"`;
  if (scope === "tag") return `tag "#${tagName}"`;
  return "this nest";
}

function normalizeUser(
  user: Omit<StewardUserEntry, "addedAt"> & { addedAt?: string },
  now: string,
): StewardUserEntry {
  return {
    userId: user.userId,
    email: user.email.trim().toLowerCase(),
    role: user.role,
    addedType: user.addedType,
    addedAt: user.addedAt ?? now,
    addedBy: user.addedBy,
  };
}

function normalizeTeam(
  team: Omit<StewardTeamEntry, "addedAt"> & { addedAt?: string },
  now: string,
): StewardTeamEntry {
  return {
    teamId: team.teamId,
    name: team.name,
    role: team.role,
    addedType: team.addedType,
    addedAt: team.addedAt ?? now,
    addedBy: team.addedBy,
  };
}

function toMultiSteward(raw: any): MultiUserSteward {
  return {
    id: String(raw._id ?? raw.id),
    nestId: raw.nestId,
    scope: raw.scope,
    documentId: raw.documentId ?? undefined,
    tagName: raw.tagName ?? undefined,
    users: Array.isArray(raw.users) ? raw.users : [],
    teams: Array.isArray(raw.teams) ? raw.teams : [],
    isActive: !!raw.isActive,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
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
