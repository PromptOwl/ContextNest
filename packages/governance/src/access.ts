/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Nest-level permission resolution.
 *
 * Decoupled from the community server: no users table (identity is the
 * email string), no license-admin path (that was the server's install
 * credential), and nest state lives in `nest_settings` instead of a `nests`
 * table. Semantics are otherwise preserved.
 */

import type { GovernanceDb } from "./db/client.js";
import { isSuperAdmin } from "./access-service.js";
import type { AccessConfig, NestSettings } from "./types.js";

export type NestPermission = "none" | "read" | "write" | "admin" | "owner";

const PERMISSION_LEVELS: Record<NestPermission, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
  owner: 4,
};

interface SettingsRow {
  nest_id: string;
  owner_email: string | null;
  visibility: string;
  stewardship_enabled: number;
  allow_self_approve: number;
}

/** Read the nest's governance settings row, or null when absent. */
export function getNestSettings(
  db: GovernanceDb,
  nestId: string,
): NestSettings | null {
  const row = db
    .prepare("SELECT * FROM nest_settings WHERE nest_id = ?")
    .get(nestId) as SettingsRow | undefined;
  if (!row) return null;
  return {
    nestId: row.nest_id,
    ownerEmail: row.owner_email,
    visibility: row.visibility === "public" ? "public" : "private",
    stewardshipEnabled: !!row.stewardship_enabled,
    allowSelfApprove: !!row.allow_self_approve,
  };
}

function directGrant(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
): NestPermission | null {
  const row = db
    .prepare(
      `SELECT permission FROM nest_collaborators
        WHERE nest_id = ? AND LOWER(user_email) = LOWER(?)`,
    )
    .get(nestId, userEmail) as { permission: NestPermission } | undefined;
  return row?.permission ?? null;
}

function hasStewardRow(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM stewards
        WHERE nest_id = ? AND is_active = 1
          AND LOWER(user_email) = LOWER(?)
        LIMIT 1`,
    )
    .get(nestId, userEmail);
}

/**
 * Resolve a user's effective permission on a nest.
 *
 * Resolution order (community semantics, minus the server-only
 * license-admin path):
 * 1. Nest owner (`nest_settings.owner_email`) -> 'owner'
 * 2. access.yaml super_admin -> 'admin' on EVERY nest. Not 'owner':
 *    owner-only actions (delete/transfer) stay with the real owner.
 * 3. Direct grant in nest_collaborators -> that permission
 * 4. An active steward row -> 'read' (stewards can reach the documents they
 *    govern even without a collaborator grant; edit/approve is still
 *    enforced per node by resolveUserRoles)
 * 5. Nest visibility = 'public' -> 'read'
 * 6. Otherwise -> 'none'
 */
export function resolveNestPermission(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
  access?: AccessConfig | null,
): NestPermission {
  const settings = getNestSettings(db, nestId);

  if (
    settings?.ownerEmail &&
    settings.ownerEmail.toLowerCase() === userEmail.toLowerCase()
  ) {
    return "owner";
  }

  if (isSuperAdmin(access ?? null, userEmail)) return "admin";

  const grant = directGrant(db, nestId, userEmail);
  if (grant) return grant;

  if (hasStewardRow(db, nestId, userEmail)) return "read";

  if (settings?.visibility === "public") return "read";

  return "none";
}

export function permissionLevel(p: NestPermission): number {
  return PERMISSION_LEVELS[p] ?? 0;
}

/**
 * True when the caller's only access path is "nest is public" — i.e. not
 * the owner, not a direct collaborator, not a super admin, not a steward,
 * but reaches the nest because visibility='public'. These callers see
 * approved content only; drafts and pending versions stay private to
 * collaborators/stewards.
 */
export function isPublicReader(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
  access?: AccessConfig | null,
): boolean {
  const settings = getNestSettings(db, nestId);
  if (!settings || settings.visibility !== "public") return false;
  if (
    settings.ownerEmail &&
    settings.ownerEmail.toLowerCase() === userEmail.toLowerCase()
  ) {
    return false;
  }
  if (directGrant(db, nestId, userEmail)) return false;
  if (isSuperAdmin(access ?? null, userEmail)) return false;
  // A steward is not a mere public reader — they govern (and may see drafts
  // of) the documents in their scope.
  if (hasStewardRow(db, nestId, userEmail)) return false;
  return true;
}
