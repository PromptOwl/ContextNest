/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Admin / seeding API — how deployments and tests manage grants and nest
 * governance state. These functions write directly to the governance DB;
 * authorization of the CALLER (e.g. via `canManageStewards`) is the
 * embedding application's responsibility.
 *
 * Identity is a plain email string throughout (no users table).
 */

import { randomUUID } from "node:crypto";
import type { GovernanceDb } from "./db/client.js";
import { ValidationError } from "./errors.js";
import {
  assignSteward,
  createStewardRecord,
} from "./stewardship-service.js";
import type {
  Collaborator,
  DocumentLifecycleStatus,
  Steward,
  StewardRole,
  StewardshipScope,
} from "./types.js";

// ─── Nest settings ──────────────────────────────────────────────────────

function ensureNestSettingsRow(db: GovernanceDb, nestId: string): void {
  db.prepare("INSERT OR IGNORE INTO nest_settings (nest_id) VALUES (?)").run(
    nestId,
  );
}

/**
 * Set (or clear) the nest owner. The owner holds implicit full edit and
 * roster-management rights; approval via ownership alone is still gated by
 * the allow-self-approve flag.
 */
export function setNestOwner(
  db: GovernanceDb,
  nestId: string,
  ownerEmail: string | null,
): void {
  ensureNestSettingsRow(db, nestId);
  db.prepare("UPDATE nest_settings SET owner_email = ? WHERE nest_id = ?").run(
    ownerEmail ? ownerEmail.trim().toLowerCase() : null,
    nestId,
  );
}

/** Set nest visibility. Public nests grant read to everyone (approved-only). */
export function setNestVisibility(
  db: GovernanceDb,
  nestId: string,
  visibility: "private" | "public",
): void {
  ensureNestSettingsRow(db, nestId);
  db.prepare("UPDATE nest_settings SET visibility = ? WHERE nest_id = ?").run(
    visibility,
    nestId,
  );
}

/** Toggle stewardship (governed mode) on/off for a nest. */
export function setStewardshipEnabled(
  db: GovernanceDb,
  nestId: string,
  enabled: boolean,
): void {
  ensureNestSettingsRow(db, nestId);
  db.prepare(
    "UPDATE nest_settings SET stewardship_enabled = ? WHERE nest_id = ?",
  ).run(enabled ? 1 : 0, nestId);
}

/** Toggle the self-approve bypass (separation-of-duties escape hatch). */
export function setAllowSelfApprove(
  db: GovernanceDb,
  nestId: string,
  allow: boolean,
): void {
  ensureNestSettingsRow(db, nestId);
  db.prepare(
    "UPDATE nest_settings SET allow_self_approve = ? WHERE nest_id = ?",
  ).run(allow ? 1 : 0, nestId);
}

// ─── Collaborators ──────────────────────────────────────────────────────

const COLLAB_PERMISSIONS = ["read", "write", "admin"] as const;
export type CollaboratorPermission = (typeof COLLAB_PERMISSIONS)[number];

/**
 * Grant (or update) a nest-wide collaborator permission for an email.
 * Upserts: re-adding an existing collaborator updates their permission.
 */
export function addCollaborator(
  db: GovernanceDb,
  nestId: string,
  email: string,
  permission: CollaboratorPermission,
  grantedBy = "admin",
): Collaborator {
  if (!COLLAB_PERMISSIONS.includes(permission)) {
    throw new ValidationError(
      `Invalid permission "${permission}" — must be read, write, or admin.`,
    );
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new ValidationError("email is required");

  const id = randomUUID();
  const grantedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO nest_collaborators (id, nest_id, user_email, permission, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(nest_id, user_email)
     DO UPDATE SET permission = excluded.permission,
                   granted_by = excluded.granted_by,
                   granted_at = excluded.granted_at`,
  ).run(id, nestId, normalized, permission, grantedBy, grantedAt);

  const row = db
    .prepare(
      "SELECT * FROM nest_collaborators WHERE nest_id = ? AND user_email = ?",
    )
    .get(nestId, normalized) as {
    id: string;
    nest_id: string;
    user_email: string;
    permission: CollaboratorPermission;
    granted_by: string;
    granted_at: string;
  };
  return {
    id: row.id,
    nestId: row.nest_id,
    userEmail: row.user_email,
    permission: row.permission,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
  };
}

/** Remove a collaborator grant. No-op when absent. */
export function removeCollaborator(
  db: GovernanceDb,
  nestId: string,
  email: string,
): void {
  db.prepare(
    "DELETE FROM nest_collaborators WHERE nest_id = ? AND LOWER(user_email) = LOWER(?)",
  ).run(nestId, email);
}

/** List collaborator grants on a nest. */
export function listCollaborators(
  db: GovernanceDb,
  nestId: string,
): Collaborator[] {
  const rows = db
    .prepare(
      "SELECT * FROM nest_collaborators WHERE nest_id = ? ORDER BY user_email",
    )
    .all(nestId) as Array<{
    id: string;
    nest_id: string;
    user_email: string;
    permission: CollaboratorPermission;
    granted_by: string;
    granted_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    nestId: row.nest_id,
    userEmail: row.user_email,
    permission: row.permission,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
  }));
}

// ─── Stewards ───────────────────────────────────────────────────────────

/**
 * Add one steward grant. Thin wrapper over `createStewardRecord` (which
 * enforces owner/self-assignment rules, duplicate detection, and flips the
 * nest into governed mode). Pass `raw: true` to bypass those checks and
 * insert directly (test seeding).
 */
export function addSteward(
  db: GovernanceDb,
  nestId: string,
  params: {
    scope: StewardshipScope;
    nodePattern?: string;
    tagName?: string;
    email: string;
    role: StewardRole;
    assignedBy?: string;
    raw?: boolean;
  },
): Steward {
  if (params.raw) {
    return assignSteward(db, {
      nestId,
      scope: params.scope,
      nodePattern: params.nodePattern,
      tagName: params.tagName
        ? params.tagName.trim().replace(/^#+/, "").toLowerCase()
        : undefined,
      userEmail: params.email.trim().toLowerCase(),
      role: params.role,
      assignedBy: params.assignedBy ?? "admin",
      assignedAt: new Date().toISOString(),
      isActive: true,
    });
  }
  const [created] = createStewardRecord(db, {
    nestId,
    scope: params.scope,
    documentId: params.nodePattern,
    tagName: params.tagName,
    users: [{ email: params.email, role: params.role }],
    assignedBy: params.assignedBy ?? "admin",
  });
  return created;
}

// ─── Node tags (steward resolution support) ─────────────────────────────

/**
 * Replace the indexed tags for a node. Tag-scoped steward resolution joins
 * on this index — the embedding application keeps it in sync with document
 * frontmatter. Tags are normalized (leading `#` stripped, lowercased).
 */
export function setNodeTags(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
  tags: string[],
): void {
  const replace = db.transaction(() => {
    db.prepare(
      "DELETE FROM node_tag_index WHERE nest_id = ? AND node_id = ?",
    ).run(nestId, nodeId);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO node_tag_index (nest_id, node_id, tag_name) VALUES (?, ?, ?)",
    );
    for (const raw of tags) {
      const norm = raw.trim().replace(/^#+/, "").toLowerCase();
      if (norm) insert.run(nestId, nodeId, norm);
    }
  });
  replace();
}

// ─── Versions (metadata) ────────────────────────────────────────────────

/** Record a node version's metadata (content stays with the engine vault). */
export function recordNodeVersion(
  db: GovernanceDb,
  params: {
    nestId: string;
    nodeId: string;
    version: number;
    contentHash: string;
    author: string;
    status?: DocumentLifecycleStatus;
    changeNote?: string;
    tags?: string[];
  },
): void {
  db.prepare(
    `INSERT INTO node_versions
       (nest_id, node_id, version, content_hash, author, status, change_note, tags_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.nestId,
    params.nodeId,
    params.version,
    params.contentHash,
    params.author,
    params.status ?? "draft",
    params.changeNote ?? null,
    params.tags ? JSON.stringify(params.tags) : null,
  );
}

/** Pin which version of a node is the approved one. */
export function setApprovedVersion(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
  version: number,
  approvedBy: string,
): void {
  db.prepare(
    `INSERT INTO approved_versions (nest_id, node_id, approved_version, approved_by, approved_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(nest_id, node_id)
     DO UPDATE SET approved_version = excluded.approved_version,
                   approved_by = excluded.approved_by,
                   approved_at = excluded.approved_at`,
  ).run(nestId, nodeId, version, approvedBy, new Date().toISOString());
}
