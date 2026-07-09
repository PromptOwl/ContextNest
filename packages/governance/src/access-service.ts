/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Access service — deployment-level access control via access.yaml.
 *
 * Decoupled from the community server: no module-level cache and no
 * DATA_ROOT global. `loadAccessConfig(dir)` reads `access.yaml` (or
 * `access.yml`) from an explicit directory, and every check takes the
 * parsed `AccessConfig | null` as its first argument. The hand-rolled YAML
 * parser is replaced with js-yaml.
 *
 * Controls: who can register, group memberships, default permissions,
 * super admins.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import type { AccessConfig } from "./types.js";

/**
 * Load access.yaml (or access.yml) from `dir`. Returns null if neither
 * file is present.
 */
export function loadAccessConfig(dir: string): AccessConfig | null {
  const candidates = [join(dir, "access.yaml"), join(dir, "access.yml")];
  for (const path of candidates) {
    if (existsSync(path)) {
      return parseAccessYaml(readFileSync(path, "utf-8"));
    }
  }
  return null;
}

/** Parse an access.yaml document into a normalized `AccessConfig`. */
export function parseAccessYaml(content: string): AccessConfig {
  const raw = load(content);
  const result: AccessConfig = {};
  if (!raw || typeof raw !== "object") return result;
  const doc = raw as Record<string, unknown>;

  if (doc.mode === "open" || doc.mode === "restricted") {
    result.mode = doc.mode;
  }
  if (Array.isArray(doc.allowed_users)) {
    result.allowed_users = doc.allowed_users
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim());
  }
  if (Array.isArray(doc.super_admins)) {
    result.super_admins = doc.super_admins
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim());
  }
  if (doc.groups && typeof doc.groups === "object") {
    result.groups = {};
    for (const [name, group] of Object.entries(
      doc.groups as Record<string, unknown>,
    )) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      const perm = g.default_permission;
      result.groups[name] = {
        members: Array.isArray(g.members)
          ? g.members
              .filter((v): v is string => typeof v === "string")
              .map((v) => v.trim())
          : [],
        default_permission:
          perm === "read" || perm === "write" || perm === "admin"
            ? perm
            : "read",
      };
    }
  }
  return result;
}

/**
 * `*.acme.com` matches any email at acme.com, including subdomains like
 * user@team.acme.com. Non-wildcard patterns must match exactly.
 */
function matchEmailPattern(email: string, pattern: string): boolean {
  if (pattern === email) return true;
  if (!pattern.startsWith("*.")) return false;
  const domain = pattern.slice(2); // "acme.com"
  const at = email.indexOf("@");
  if (at < 0) return false;
  const emailDomain = email.slice(at + 1); // "team.acme.com" / "acme.com"
  return emailDomain === domain || emailDomain.endsWith("." + domain);
}

/**
 * Check whether an email is allowed to join the deployment.
 * With no config, or mode !== "restricted", everyone is allowed.
 */
export function isEmailAllowed(
  config: AccessConfig | null,
  email: string,
): boolean {
  if (!config || config.mode !== "restricted") return true;
  if (!config.allowed_users?.length) return true;

  const lower = email.toLowerCase();
  return config.allowed_users.some((pattern) =>
    matchEmailPattern(lower, pattern.toLowerCase()),
  );
}

/** The groups a user belongs to based on their email. */
export function getGroupsForUser(
  config: AccessConfig | null,
  email: string,
): string[] {
  if (!config?.groups) return [];
  const lower = email.toLowerCase();

  return Object.entries(config.groups)
    .filter(([, group]) =>
      group.members.some((m) => matchEmailPattern(lower, m.toLowerCase())),
    )
    .map(([name]) => name);
}

/** The highest default permission for a user based on group membership. */
export function getDefaultPermission(
  config: AccessConfig | null,
  email: string,
): "read" | "write" | "admin" | null {
  if (!config?.groups) return null;

  const groups = getGroupsForUser(config, email);
  if (groups.length === 0) return null;

  const levels = { read: 1, write: 2, admin: 3 };
  let best: "read" | "write" | "admin" | null = null;

  for (const groupName of groups) {
    const group = config.groups[groupName];
    if (!group) continue;
    const perm = group.default_permission;
    if (!best || levels[perm] > levels[best]) {
      best = perm;
    }
  }

  return best;
}

/** Check whether a user is a super admin (case-insensitive). */
export function isSuperAdmin(
  config: AccessConfig | null,
  email: string,
): boolean {
  if (!config?.super_admins) return false;
  return config.super_admins
    .map((e) => e.toLowerCase())
    .includes(email.toLowerCase());
}
