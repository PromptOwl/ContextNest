/**
 * Shared types for steward stores.
 *
 * Two storage shapes ship from the engine; both expose `resolveStewards`
 * returning the same `ResolvedStewardEntry[]` so callers can swap stores
 * without rewriting permission code.
 *
 *   - SingleUserStewardStore — one row per (scope, target, user). Matches
 *     contextnest-community canonical shape.
 *   - MultiUserStewardStore  — one row per (scope, target) with embedded
 *     `users[]` + `teams[]`. Matches PromptOwl TheOwl shape.
 *
 * Canonical scope set is `document | tag | nest`. Consumers with legacy
 * scope values (folder, dataRoom) collapse them at their boundary before
 * calling engine.
 */

export type StewardRole = "editor" | "reviewer" | "viewer";

export type StewardshipScope = "document" | "tag" | "nest";

/** Role granted to all members of a team (multi-user store only). */
export type StewardAddedType = "steward" | "mention";

/** Single-user steward row (community shape). */
export interface SingleUserSteward {
  id: string;
  nestId: string;
  scope: StewardshipScope;
  documentId?: string;
  tagName?: string;
  userEmail: string;
  userId?: string;
  role: StewardRole;
  assignedBy: string;
  assignedAt: string;
  isActive: boolean;
}

/** User entry inside a multi-user steward row. */
export interface StewardUserEntry {
  userId?: string;
  email: string;
  role: StewardRole;
  addedType: StewardAddedType;
  addedAt: string;
  addedBy?: string;
}

/** Team entry inside a multi-user steward row. */
export interface StewardTeamEntry {
  teamId: string;
  name: string;
  role: StewardRole;
  addedType: StewardAddedType;
  addedAt: string;
  addedBy?: string;
}

/** Multi-user steward row (TheOwl shape: one record per scope-target). */
export interface MultiUserSteward {
  id: string;
  nestId: string;
  scope: StewardshipScope;
  documentId?: string;
  tagName?: string;
  users: StewardUserEntry[];
  teams: StewardTeamEntry[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Flattened, per-grant resolution result. Both stores produce this shape so
 * downstream permission logic works against a single union.
 *
 * `priority`: 1 = document scope, 2 = tag, 3 = nest. Lower wins.
 * `via`: how the grant reached the user — direct user grant or via team
 * membership (multi-user store only).
 */
export interface ResolvedStewardEntry {
  email?: string;
  userId?: string;
  teamId?: string;
  teamName?: string;
  role: StewardRole;
  scope: StewardshipScope;
  priority: number;
  source: string;
  via: "user" | "team";
}

/** Optional inputs for resolveStewards. */
export interface ResolveStewardsInput {
  /** Document id; required to resolve document-scope and tag-scope grants. */
  nodeId?: string;
  /**
   * Tag names attached to `nodeId`. Engine has no node-tag-index of its own
   * (tags live in document frontmatter); the caller supplies them so the
   * store can match `tag`-scope rows without re-reading every document.
   * Pass without leading `#`.
   */
  tags?: string[];
}
