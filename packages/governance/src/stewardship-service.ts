/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Stewardship service — SQLite implementation of the stewardship layer.
 *
 * Ported from the community server, decoupled from its HTTP/auth stack:
 * every function takes an explicit `GovernanceDb` handle; identity is the
 * caller-supplied email string (no users table); nest state comes from
 * `nest_settings`; the server's open-auth-mode bypass is dropped (a
 * deployment without governance simply doesn't install this module).
 * Functions are synchronous because better-sqlite3 is synchronous — the
 * async `StewardshipAdapter` contract remains for other backends.
 *
 * Resolution hierarchy: document(1) > tag(2) > nest(3).
 */

import { randomUUID } from "node:crypto";
import type { GovernanceDb } from "./db/client.js";
import { isSuperAdmin } from "./access-service.js";
import {
  getNestSettings,
  resolveNestPermission,
} from "./access.js";
import { ConflictError, ValidationError } from "./errors.js";
import {
  type EffectiveRole,
  collabPermToRole,
  canViewWith,
  canEditWith,
  primaryRole,
} from "./roles.js";
import type {
  AccessConfig,
  Steward,
  ResolvedSteward,
  StewardsConfig,
  StewardEntry,
  StewardshipScope,
  StewardRole,
} from "./types.js";

/** Options shared by the permission checks. */
export interface PermissionOptions {
  /** Parsed access.yaml, for super-admin recognition. */
  access?: AccessConfig | null;
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export function assignSteward(
  db: GovernanceDb,
  data: Omit<Steward, "id">,
): Steward {
  const id = randomUUID();

  db.prepare(
    `INSERT INTO stewards
     (id, nest_id, scope, node_pattern, tag_name, user_email, role, assigned_by, assigned_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.nestId,
    data.scope,
    data.nodePattern || null,
    data.tagName || null,
    data.userEmail,
    data.role,
    data.assignedBy,
    data.assignedAt,
    data.isActive ? 1 : 0,
  );

  return { ...data, id };
}

export function removeSteward(db: GovernanceDb, id: string): void {
  // Steward and collaborator grants are independent — removing a steward
  // only drops the steward row. Any nest_collaborators access the user has
  // is managed separately and left untouched.
  db.prepare("DELETE FROM stewards WHERE id = ?").run(id);
}

const VALID_STEWARD_ROLES: StewardRole[] = ["editor", "reviewer", "viewer"];

export interface StewardUpdate {
  role?: StewardRole;
  /** Provide to re-scope the steward. Omit to leave scope/target untouched. */
  scope?: StewardshipScope;
  documentId?: string;
  tagName?: string;
}

/**
 * Update an existing steward's role and/or scope in place, so an admin
 * doesn't have to remove-and-re-add to adjust it. Role moves alone when only
 * `role` is given; passing `scope` re-targets the row (and clears the unused
 * target columns). Re-scoping is guarded against duplicates: another active
 * row for the same (nest, scope, target, user) is rejected with a
 * `ConflictError`.
 */
export function updateSteward(
  db: GovernanceDb,
  id: string,
  update: StewardUpdate,
): Steward {
  const current = db
    .prepare("SELECT * FROM stewards WHERE id = ? AND is_active = 1")
    .get(id) as Record<string, unknown> | undefined;
  if (!current) {
    throw new ValidationError("Steward not found");
  }

  const role: StewardRole = update.role ?? (current.role as StewardRole);
  if (!VALID_STEWARD_ROLES.includes(role)) {
    throw new ValidationError(
      `Invalid role "${role}" — must be editor, reviewer, or viewer.`,
    );
  }

  // Default to the current scope/target; only recompute when re-scoping.
  let scope: StewardshipScope = current.scope as StewardshipScope;
  let nodePattern: string | null = (current.node_pattern as string) ?? null;
  let tagName: string | null = (current.tag_name as string) ?? null;

  if (update.scope) {
    scope = update.scope;
    nodePattern = null;
    tagName = null;
    switch (scope) {
      case "document":
        if (!update.documentId)
          throw new ValidationError("documentId required for document scope");
        nodePattern = update.documentId;
        break;
      case "tag":
        if (!update.tagName)
          throw new ValidationError("tagName required for tag scope");
        tagName = update.tagName.trim().replace(/^#+/, "").toLowerCase();
        break;
      case "nest":
        break;
    }

    // Block collision: same user can't hold two rows for the same scope+target.
    const dup = db
      .prepare(
        `SELECT role FROM stewards
           WHERE nest_id = ? AND is_active = 1 AND id != ? AND scope = ?
             AND user_email = ?
             AND COALESCE(node_pattern, '') = COALESCE(?, '')
             AND COALESCE(tag_name, '') = COALESCE(?, '')`,
      )
      .get(
        current.nest_id,
        id,
        scope,
        current.user_email,
        nodePattern,
        tagName,
      ) as { role: string } | undefined;
    if (dup) {
      const scopeLabel =
        scope === "document"
          ? `document "${nodePattern}"`
          : scope === "tag"
            ? `tag "#${tagName}"`
            : "this nest";
      throw new ConflictError(
        `"${current.user_email}" is already a steward of ${scopeLabel} with the "${dup.role}" role.`,
      );
    }
  }

  db.prepare(
    "UPDATE stewards SET role = ?, scope = ?, node_pattern = ?, tag_name = ? WHERE id = ?",
  ).run(role, scope, nodePattern, tagName, id);

  const row = db.prepare("SELECT * FROM stewards WHERE id = ?").get(id);
  return rowToSteward(row as StewardRow);
}

/** Back-compat thin wrapper — role-only update. */
export function updateStewardRole(
  db: GovernanceDb,
  id: string,
  role: StewardRole,
): Steward {
  return updateSteward(db, id, { role });
}

export function getSteward(db: GovernanceDb, id: string): Steward | null {
  const row = db.prepare("SELECT * FROM stewards WHERE id = ?").get(id) as
    | StewardRow
    | undefined;
  return row ? rowToSteward(row) : null;
}

export function getStewardsForNest(
  db: GovernanceDb,
  nestId: string,
): Steward[] {
  const rows = db
    .prepare("SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1")
    .all(nestId) as StewardRow[];
  return rows.map(rowToSteward);
}

export function getStewardsForScope(
  db: GovernanceDb,
  params: {
    nestId: string;
    scope?: StewardshipScope;
    scopeTarget?: string;
  },
): Steward[] {
  let sql = "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1";
  const args: unknown[] = [params.nestId];

  if (params.scope) {
    sql += " AND scope = ?";
    args.push(params.scope);
  }
  if (params.scopeTarget) {
    sql += " AND (node_pattern = ? OR tag_name = ?)";
    args.push(params.scopeTarget, params.scopeTarget);
  }

  return (db.prepare(sql).all(...args) as StewardRow[]).map(rowToSteward);
}

/**
 * List stewards with filters. (Community version also resolved document
 * titles from on-disk frontmatter; that server-storage concern is dropped —
 * callers can resolve titles through the engine if needed.)
 */
export function listStewards(
  db: GovernanceDb,
  params: {
    nestId: string;
    scope?: StewardshipScope;
    search?: string;
  },
): Steward[] {
  let sql = "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1";
  const args: unknown[] = [params.nestId];

  if (params.scope) {
    sql += " AND scope = ?";
    args.push(params.scope);
  }
  if (params.search) {
    sql += " AND (user_email LIKE ? OR tag_name LIKE ? OR node_pattern LIKE ?)";
    const like = `%${params.search.toLowerCase()}%`;
    args.push(like, like, like);
  }
  sql += " ORDER BY scope, COALESCE(node_pattern, tag_name, ''), user_email";
  return (db.prepare(sql).all(...args) as StewardRow[]).map(rowToSteward);
}

/**
 * Create a steward record for a (scope, target) with N users.
 * Inserts one row per user — partial unique indexes enforce idempotency.
 * Returns the inserted rows.
 *
 * Stewardship and collaboration are independent grants: a steward row grants
 * scoped document/context rights, a collaborator row grants nest-wide access.
 * We do NOT mirror a collaborator row here — nest visibility for stewards
 * comes from `resolveNestPermission` recognizing steward rows, and
 * edit/approve rights come from `resolveUserRoles` merging both sources.
 */
export function createStewardRecord(
  db: GovernanceDb,
  params: {
    nestId: string;
    scope: StewardshipScope;
    documentId?: string;
    tagName?: string;
    users: Array<{
      email: string;
      role?: StewardRole;
    }>;
    assignedBy: string;
  },
): Steward[] {
  if (params.users.length === 0) {
    throw new ValidationError("At least one user is required");
  }

  // Pick the right target column for the scope.
  let nodePattern: string | undefined;
  let tagName: string | undefined;
  switch (params.scope) {
    case "document":
      if (!params.documentId)
        throw new ValidationError("documentId required for document scope");
      nodePattern = params.documentId;
      break;
    case "tag":
      if (!params.tagName)
        throw new ValidationError("tagName required for tag scope");
      tagName = params.tagName.trim().replace(/^#+/, "").toLowerCase();
      break;
    case "nest":
      break;
  }

  const results: Steward[] = [];

  // The nest owner is an implicit admin with full edit/approve rights, so they
  // never need an explicit steward grant — and giving the owner a reviewer row
  // makes their effective role ambiguous (owner edit vs reviewer approve/reject
  // on the same doc). Likewise, whoever manages the roster can't grant a
  // steward role to themselves. Block both so the roster only holds delegated
  // users.
  const actor = (params.assignedBy || "").trim().toLowerCase();
  const ownerEmail = (getNestOwnerEmail(db, params.nestId) || "").toLowerCase();

  for (const user of params.users) {
    const email = user.email.trim().toLowerCase();
    if (!email) continue;

    if (email === actor) {
      throw new ValidationError(
        "You already manage this nest, so you can't add yourself as a steward.",
      );
    }
    if (ownerEmail && email === ownerEmail) {
      throw new ValidationError(
        "The nest owner already has full access and doesn't need a steward role.",
      );
    }

    // Check for existing active row (idempotent).
    const existing = db
      .prepare(
        `SELECT * FROM stewards
           WHERE nest_id = ? AND is_active = 1 AND scope = ? AND user_email = ?
             AND COALESCE(node_pattern, '') = COALESCE(?, '')
             AND COALESCE(tag_name, '') = COALESCE(?, '')`,
      )
      .get(
        params.nestId,
        params.scope,
        email,
        nodePattern ?? null,
        tagName ?? null,
      ) as StewardRow | undefined;

    if (existing) {
      const scopeLabel =
        params.scope === "document"
          ? `document "${nodePattern}"`
          : params.scope === "tag"
            ? `tag "#${tagName}"`
            : "this nest";
      throw new ConflictError(
        `"${email}" is already a steward of ${scopeLabel} with the "${existing.role}" role. Remove the existing assignment first to change the role.`,
      );
    }

    const created = assignSteward(db, {
      nestId: params.nestId,
      scope: params.scope,
      nodePattern,
      tagName,
      userEmail: email,
      role: user.role ?? "reviewer",
      assignedBy: params.assignedBy,
      assignedAt: new Date().toISOString(),
      isActive: true,
    });
    results.push(created);
  }

  // If adding any stewards, ensure governed mode is on.
  ensureNestSettingsRow(db, params.nestId);
  db.prepare(
    "UPDATE nest_settings SET stewardship_enabled = 1 WHERE nest_id = ? AND stewardship_enabled = 0",
  ).run(params.nestId);

  return results;
}

// ─── STEWARD RESOLUTION ─────────────────────────────────────────────────
// Priority: document(1) > tag(2) > nest(3).
//
// Executed as a single SQL UNION ALL so large vaults don't pay an in-memory
// scan. Tags are read from node_tag_index. Document scope is exact match.

export interface ResolveResult {
  stewards: ResolvedSteward[];
  fallbackToOwner: boolean;
  ownerEmail?: string;
}

export function resolveStewardsForNode(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
): ResolvedSteward[] {
  return resolve(db, nestId, nodeId).stewards;
}

export function resolveStewardsWithFallback(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
): ResolveResult {
  return resolve(db, nestId, nodeId);
}

type StewardRow = {
  id: string;
  nest_id: string;
  scope: string;
  node_pattern: string | null;
  tag_name: string | null;
  user_email: string;
  role: string;
  assigned_by: string;
  assigned_at: string;
  is_active: number;
};

type ResolvedRow = StewardRow & {
  priority: number;
  match_source: string;
};

function resolve(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
): ResolveResult {
  // Document: exact match on node_pattern.
  // Tag: JOIN on node_tag_index for fast tag lookup.
  // Nest: unconditional.
  const rows = db
    .prepare(
      `
      SELECT s.*, 1 AS priority, ('document: ' || s.node_pattern) AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'document'
          AND s.node_pattern = ?
      UNION ALL
      SELECT s.*, 2 AS priority, ('tag: ' || s.tag_name) AS match_source
        FROM stewards s
        JOIN node_tag_index nt
          ON nt.nest_id = s.nest_id
         AND nt.tag_name = s.tag_name
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'tag'
          AND nt.node_id = ?
      UNION ALL
      SELECT s.*, 3 AS priority, 'nest-level steward' AS match_source
        FROM stewards s
        WHERE s.nest_id = ? AND s.is_active = 1 AND s.scope = 'nest'
      ORDER BY priority ASC, user_email ASC
      `,
    )
    .all(
      nestId,
      nodeId, // document branch
      nestId,
      nodeId, // tag branch
      nestId, // nest branch
    ) as ResolvedRow[];

  const resolved: ResolvedSteward[] = rows.map((row) => ({
    steward: rowToSteward(row),
    priority: row.priority,
    source: row.match_source,
  }));

  if (resolved.length > 0) {
    return { stewards: resolved, fallbackToOwner: false };
  }

  // Fallback: nest owner is the implicit steward when nothing resolves.
  const ownerEmail = getNestOwnerEmail(db, nestId);

  return {
    stewards: [],
    fallbackToOwner: true,
    ownerEmail: ownerEmail ?? undefined,
  };
}

// ─── UNIFIED ROLE RESOLUTION ────────────────────────────────────────────
// Merge collaborator perms (nest_collaborators) + steward rows into one
// effective-role array. See roles.ts for the vocabulary and capability map.

/** Distinct active steward roles a user holds anywhere on the nest. */
export function getStewardRolesForUser(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
): StewardRole[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT role FROM stewards WHERE nest_id = ? AND is_active = 1 AND LOWER(user_email) = LOWER(?)",
    )
    .all(nestId, userEmail) as { role: StewardRole }[];
  return rows.map((r) => r.role);
}

/**
 * The caller's own active steward rows (with scope), not the whole roster.
 * The full roster is admin-only, but a reviewer/editor still needs their own
 * scoped rows to drive per-node affordances — this exposes just those.
 */
export function getStewardsForUser(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
): Steward[] {
  const rows = db
    .prepare(
      "SELECT * FROM stewards WHERE nest_id = ? AND is_active = 1 AND LOWER(user_email) = LOWER(?)",
    )
    .all(nestId, userEmail) as StewardRow[];
  return rows.map(rowToSteward);
}

/** A user's nest_collaborators.permission, or null if not a collaborator. */
export function getCollaboratorRole(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
): string | null {
  const row = db
    .prepare(
      "SELECT permission FROM nest_collaborators WHERE nest_id = ? AND LOWER(user_email) = LOWER(?)",
    )
    .get(nestId, userEmail) as { permission: string } | undefined;
  return row?.permission ?? null;
}

/**
 * Effective roles for a user on a nest, merged from collaborator access and
 * steward assignments. When `nodeId` is given, steward rows are resolved for
 * that node (document > tag > nest); otherwise every active steward row on
 * the nest counts (used for list display and coarse nest-wide gating).
 */
export function resolveUserRoles(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
  opts?: { nodeId?: string; access?: AccessConfig | null },
): EffectiveRole[] {
  const roles = new Set<EffectiveRole>();
  const access = opts?.access ?? null;

  if (isSuperAdmin(access, userEmail)) roles.add("admin");

  const owner = getNestOwnerEmail(db, nestId);
  if (owner && owner.toLowerCase() === userEmail.toLowerCase()) {
    roles.add("owner");
  }

  // Collaborator access (nest-wide). resolveNestPermission also yields the
  // public-visibility 'read' fallback, so public readers resolve to viewer.
  const collabRole = collabPermToRole(
    resolveNestPermission(db, nestId, userEmail, access),
  );
  if (collabRole) roles.add(collabRole);

  // Steward assignments — scoped to the node when one is given.
  const stewardRoles = opts?.nodeId
    ? resolveStewardsForNode(db, nestId, opts.nodeId)
        .filter(
          (r) => r.steward.userEmail.toLowerCase() === userEmail.toLowerCase(),
        )
        .map((r) => r.steward.role)
    : getStewardRolesForUser(db, nestId, userEmail);
  for (const role of stewardRoles) roles.add(role);

  return [...roles];
}

// ─── PERMISSION CHECKS ──────────────────────────────────────────────────
// Resolution merges collaborator + steward roles via resolveUserRoles.
//
// Rules:
//   super-admin (access.yaml)  -> edit + access; approve like an admin steward
//   nest owner                 -> edit + access. APPROVAL is gated by the
//                                 nest's allow_self_approve flag: off ->
//                                 approvals go to assigned reviewers (the
//                                 owner can't approve via ownership alone);
//                                 on -> the owner can approve anything,
//                                 including their own submissions (seeding).
//                                 An owner who ALSO holds a reviewer/admin
//                                 steward role approves teammates' work via
//                                 that role regardless of the flag.
//   steward role=admin/reviewer-> approve + reject + access (NOT own work,
//                                 unless they're the owner and the flag is on)
//   steward role=editor        -> edit + access
//   steward role=viewer        -> access only

export type PermissionRole =
  | "super_admin"
  | "owner"
  | "admin"
  | StewardRole
  | null;

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  role?: PermissionRole;
}

/**
 * Can this user manage the steward roster (assign/remove/sync)? Allowed for
 * an access.yaml super_admin, the nest owner, or an admin collaborator on
 * THIS nest — so an owner can delegate people-management by granting admin.
 * (The community server also bypassed this in open auth mode; there is no
 * auth mode here — an ungoverned deployment simply doesn't load this module.)
 */
export function canManageStewards(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
  opts?: PermissionOptions,
): boolean {
  // resolveNestPermission already folds access.yaml super_admins into
  // nest-level "admin", so one lookup covers server admins, the nest owner,
  // and admin collaborators.
  const perm = resolveNestPermission(db, nestId, userEmail, opts?.access);
  return perm === "owner" || perm === "admin";
}

/**
 * Can this user create a new document in the nest? Nest-wide write
 * (owner/admin/write collaborator) or a nest-scope editor steward.
 */
export function canCreateInNest(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
  opts?: PermissionOptions,
): boolean {
  if (isSuperAdmin(opts?.access ?? null, userEmail)) return true;
  const perm = resolveNestPermission(db, nestId, userEmail, opts?.access);
  if (perm === "owner" || perm === "admin" || perm === "write") return true;
  return getStewardsForUser(db, nestId, userEmail).some(
    (s) => s.role === "editor" && s.scope === "nest",
  );
}

function getNestOwnerEmail(db: GovernanceDb, nestId: string): string | null {
  return getNestSettings(db, nestId)?.ownerEmail ?? null;
}

function ensureNestSettingsRow(db: GovernanceDb, nestId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO nest_settings (nest_id) VALUES (?)",
  ).run(nestId);
}

export function canUserEdit(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
  userEmail: string,
  opts?: PermissionOptions,
): PermissionResult {
  const roles = resolveUserRoles(db, nestId, userEmail, {
    nodeId,
    access: opts?.access,
  });
  if (roles.includes("owner")) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }
  if (isSuperAdmin(opts?.access ?? null, userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  if (canEditWith(roles)) {
    return {
      allowed: true,
      reason: "editor access (collaborator or steward)",
      role: roles.includes("admin") ? "admin" : "editor",
    };
  }
  return { allowed: false, reason: "no editor role on this node", role: null };
}

function getCurrentVersionAuthor(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT author FROM node_versions
         WHERE nest_id = ? AND node_id = ?
         ORDER BY version DESC LIMIT 1`,
    )
    .get(nestId, nodeId) as { author: string } | undefined;
  return row?.author ?? null;
}

/**
 * For separation of duties: the email that triggered the current pending
 * review wins over the original version author. The requester is the
 * proximate "actor" asking for approval, so SoD should block them — not
 * whoever happened to write an earlier edit. Returns null when no pending
 * review exists.
 */
function getPendingReviewRequester(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT requested_by FROM review_requests
         WHERE nest_id = ? AND node_id = ? AND status = 'pending'
         ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(nestId, nodeId) as { requested_by: string } | undefined;
  return row?.requested_by ?? null;
}

export function canUserApprove(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
  userEmail: string,
  opts?: PermissionOptions,
): PermissionResult {
  const access = opts?.access ?? null;
  const roles = resolveUserRoles(db, nestId, userEmail, { nodeId, access });
  const isOwner = roles.includes("owner");
  const isSuper = isSuperAdmin(access, userEmail);
  const allowSelf = !!getNestSettings(db, nestId)?.allowSelfApprove;
  // Explicit approve-capable steward role (admin or reviewer), NOT the
  // ownership-derived right. Owner-only callers resolve to ["owner"] and
  // fall through to the ownership branch below; an owner who is ALSO an
  // admin/reviewer steward keeps that role's powers here.
  const hasStewardApprove =
    roles.includes("admin") || roles.includes("reviewer");

  // The actor is the user who SUBMITTED the version for review (or the
  // version author as a fallback). We compare against
  // review_requests.requested_by so that when a teammate submits someone
  // else's earlier edit, the original author can still approve.
  const actor =
    getPendingReviewRequester(db, nestId, nodeId) ??
    getCurrentVersionAuthor(db, nestId, nodeId);
  const isOwnSubmission =
    !!actor && actor.toLowerCase() === userEmail.toLowerCase();

  // Path 1 — explicit steward (admin/reviewer): approve teammates' work
  // always. Own submission is blocked by separation of duties, UNLESS the
  // caller is also the owner/super-admin and the nest opts into self-approve
  // (seeding).
  if (hasStewardApprove) {
    if (isOwnSubmission && !((isOwner || isSuper) && allowSelf)) {
      return {
        allowed: false,
        reason:
          "You submitted this version for review, so you can't approve it yourself. Ask another reviewer to approve it (separation of duties).",
        role: roles.includes("admin") ? "admin" : "reviewer",
      };
    }
    return {
      allowed: true,
      reason: "reviewer access (collaborator or steward)",
      role: roles.includes("admin") ? "admin" : "reviewer",
    };
  }

  // Path 2 — ownership/super-admin without a steward role. Approval is gated
  // by the nest's allow_self_approve flag: off -> approvals go to assigned
  // reviewers; on -> the owner may approve anything, including own
  // submissions.
  if (isOwner || isSuper) {
    if (allowSelf) {
      return {
        allowed: true,
        reason: isOwner ? "nest owner (self-approve enabled)" : "super admin",
        role: isOwner ? "owner" : "super_admin",
      };
    }
    return {
      allowed: false,
      reason:
        "Approvals go to assigned reviewers while self-approve is off. Enable self-approve in nest settings to approve directly (e.g. while seeding), or add a reviewer steward.",
      role: isOwner ? "owner" : "super_admin",
    };
  }

  // Path 3 — editor/viewer/plain collaborator: no approval rights.
  const held = primaryRole(roles);
  return {
    allowed: false,
    reason: held
      ? `You're a "${held}" on this document — only reviewers (or admins) can approve. Ask the nest owner to grant you the reviewer steward role.`
      : "You're not a steward on this document, so you can't approve it. Ask the nest owner to add you as a reviewer.",
    role: held,
  };
}

export function canUserAccess(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
  userEmail: string,
  opts?: PermissionOptions,
): PermissionResult {
  const roles = resolveUserRoles(db, nestId, userEmail, {
    nodeId,
    access: opts?.access,
  });
  if (roles.includes("owner")) {
    return { allowed: true, reason: "nest owner", role: "owner" };
  }
  if (isSuperAdmin(opts?.access ?? null, userEmail)) {
    return { allowed: true, reason: "super admin", role: "super_admin" };
  }
  if (canViewWith(roles)) {
    return {
      allowed: true,
      reason: "collaborator or steward access",
      role: primaryRole(roles),
    };
  }
  return {
    allowed: false,
    reason: "no collaborator or steward access",
    role: null,
  };
}

// ─── SYNC FROM stewards.yaml ────────────────────────────────────────────

export function syncFromConfig(
  db: GovernanceDb,
  nestId: string,
  config: StewardsConfig,
): number {
  let count = 0;

  // Deactivate existing stewards for this nest (will re-create from config).
  db.prepare("UPDATE stewards SET is_active = 0 WHERE nest_id = ?").run(nestId);

  // Declaring stewards via config implies governed mode — flip the flag.
  ensureNestSettingsRow(db, nestId);
  db.prepare(
    "UPDATE nest_settings SET stewardship_enabled = 1 WHERE nest_id = ?",
  ).run(nestId);

  const addEntries = (
    scope: StewardshipScope,
    entries: StewardEntry[],
    target?: { nodePattern?: string; tagName?: string },
  ) => {
    for (const entry of entries) {
      // Legacy 'admin' role maps to 'reviewer'.
      const rawRole = entry.role || "reviewer";
      const role: StewardRole =
        (rawRole as string) === "admin" ? "reviewer" : (rawRole as StewardRole);

      assignSteward(db, {
        nestId,
        scope,
        nodePattern: target?.nodePattern,
        tagName: target?.tagName
          ? target.tagName.trim().replace(/^#+/, "").toLowerCase()
          : undefined,
        userEmail: entry.email.toLowerCase(),
        role,
        assignedBy: "config",
        assignedAt: new Date().toISOString(),
        isActive: true,
      });
      count++;
    }
  };

  // Nest-level stewards
  if (config.nest) {
    addEntries("nest", config.nest);
  }

  // Tag-level stewards
  if (config.tags) {
    for (const [tagName, entries] of Object.entries(config.tags)) {
      addEntries("tag", entries, { tagName });
    }
  }

  // Document-level stewards
  if (config.documents) {
    for (const [docPattern, entries] of Object.entries(config.documents)) {
      addEntries("document", entries, { nodePattern: docPattern });
    }
  }

  return count;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function rowToSteward(row: StewardRow): Steward {
  return {
    id: row.id,
    nestId: row.nest_id,
    scope: row.scope as StewardshipScope,
    nodePattern: row.node_pattern || undefined,
    tagName: row.tag_name || undefined,
    userEmail: row.user_email,
    role: row.role as StewardRole,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    isActive: !!row.is_active,
  };
}
