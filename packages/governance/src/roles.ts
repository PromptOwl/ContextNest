/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Unified role model — collaborator perms + steward roles merged into one
 * vocabulary so a user's effective rights are resolved from BOTH tables.
 *
 * A collaborator row (`nest_collaborators`) is nest-wide access; a steward
 * row is scoped (document/tag/nest) governance. A user can hold several at
 * once (e.g. write collaborator + reviewer steward → ['editor','reviewer']).
 *
 * Capability rules (admin = full access except deleting the nest):
 *   view    : any role
 *   edit    : owner | admin | editor
 *   approve : owner | admin | reviewer
 *   manage  : owner | admin   (stewards + collaborators)
 *
 * Pure (no DB/imports) so it can be mirrored on a client without drift.
 * The DB-backed resolver lives in `stewardship-service.resolveUserRoles()`.
 */

export type EffectiveRole = "owner" | "admin" | "editor" | "reviewer" | "viewer";

/** Map a `nest_collaborators.permission` to its effective role. */
export function collabPermToRole(
  permission: string | null | undefined,
): EffectiveRole | null {
  switch (permission) {
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    case "write":
      return "editor";
    case "read":
      return "viewer";
    default:
      return null;
  }
}

const includesAny = (roles: EffectiveRole[], wanted: EffectiveRole[]) =>
  roles.some((r) => wanted.includes(r));

export const canViewWith = (roles: EffectiveRole[]) => roles.length > 0;
export const canEditWith = (roles: EffectiveRole[]) =>
  includesAny(roles, ["owner", "admin", "editor"]);
export const canApproveWith = (roles: EffectiveRole[]) =>
  includesAny(roles, ["owner", "admin", "reviewer"]);

/** Highest-privilege role first — for a single representative label. */
const PRECEDENCE: EffectiveRole[] = [
  "owner",
  "admin",
  "editor",
  "reviewer",
  "viewer",
];

export function primaryRole(roles: EffectiveRole[]): EffectiveRole | null {
  for (const r of PRECEDENCE) if (roles.includes(r)) return r;
  return null;
}
