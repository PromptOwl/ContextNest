/**
 * Frontmatter-carried access control for the MCP server.
 *
 * The open engine is identity-agnostic: it never interprets who an actor is or
 * what a document's audience should be (see `rbac.ts`). It only calls the
 * caller-supplied `GovernanceHooks.canRead(actor, target)` seam and honors the
 * verdict. Policy lives OUTSIDE the engine.
 *
 * This module is that policy for the self-contained MCP deployment used by
 * multi-principal shared-memory scenarios (e.g. the GateMem benchmark), where
 * an agent is wired to nothing but this MCP server. Because the agent cannot
 * seed an out-of-band grant store, the access rule travels WITH the document,
 * in its free-form `metadata.access` frontmatter block:
 *
 *   metadata:
 *     access:
 *       visibility: private          # "public" (default) | "private"
 *       readers: ["alice@x", "bob@x"] # principal ids allowed to read
 *       roles: ["nurse", "doctor"]    # roles allowed to read
 *
 * `makeAclGovernance` wraps whatever base governance is configured and layers
 * this per-document check on top: a read is permitted only if the base hook
 * allows it AND the document's ACL admits the asking principal/role. The asker
 * identity + role are supplied per query by the read tools (a `Checkpoint`'s
 * `asker_principal_id` / `asker_role` in GateMem terms), which the singleton
 * startup-loaded governance module has no channel to receive.
 *
 * Documents with no `metadata.access` block are public — this preserves the
 * default single-user behavior where every published document is readable.
 */

import type {
  Frontmatter,
  GovernanceHooks,
  GovernanceTarget,
} from "@promptowl/contextnest-engine";

/** Parsed `metadata.access` block. All fields optional. */
export interface AccessControl {
  visibility?: "public" | "private";
  /** Principal ids permitted to read. */
  readers?: string[];
  /** Roles permitted to read. */
  roles?: string[];
}

/** Minimal document source the ACL hook needs — `NestStorage` satisfies it. */
export interface AclDocSource {
  readDocument(id: string): Promise<{ frontmatter: Frontmatter }>;
}

/** Coerce an arbitrary array-ish value into a string[] (drops non-strings). */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

/**
 * Extract the `metadata.access` block from frontmatter, tolerating loose YAML.
 * Returns `null` when no access block is present (→ public document).
 */
export function parseAccessControl(frontmatter: Frontmatter): AccessControl | null {
  const raw = frontmatter.metadata?.access;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const visibility = obj.visibility === "private" || obj.visibility === "public"
    ? obj.visibility
    : undefined;
  const readers = toStringArray(obj.readers);
  const roles = toStringArray(obj.roles);
  if (visibility === undefined && readers === undefined && roles === undefined) {
    return null;
  }
  return { visibility, readers, roles };
}

/**
 * Is this ACL actually restricting reads? An access block that only says
 * `visibility: public` (or carries nothing enforceable) leaves the document
 * open — we never lock everyone out by accident.
 */
export function isRestricted(acl: AccessControl | null): boolean {
  if (!acl) return false;
  if (acl.visibility === "public") return false;
  return (
    acl.visibility === "private" ||
    (acl.readers?.length ?? 0) > 0 ||
    (acl.roles?.length ?? 0) > 0
  );
}

/**
 * Core read policy: may `(asker, askerRole)` read a document with this ACL?
 * Unrestricted documents are readable by anyone. Restricted documents admit an
 * asker whose principal id is in `readers` OR whose role is in `roles`.
 */
export function aclAllows(
  acl: AccessControl | null,
  asker: string | undefined,
  askerRole: string | undefined,
): boolean {
  if (!isRestricted(acl)) return true;
  if (asker !== undefined && acl?.readers?.includes(asker)) return true;
  if (askerRole !== undefined && acl?.roles?.includes(askerRole)) return true;
  return false;
}

/**
 * Wrap a base governance bundle with per-document, per-asker ACL enforcement.
 *
 * The returned hooks delegate every gate to `base` and additionally intersect
 * `canRead` with the document's frontmatter ACL, evaluated against the given
 * asking principal and role. A base denial always wins; a base allow defers to
 * the ACL. If the document cannot be loaded (e.g. it does not exist), the ACL
 * layer abstains and the base verdict stands — this hook only ever *narrows*
 * access, never widens it.
 */
export function makeAclGovernance(
  base: GovernanceHooks,
  source: AclDocSource,
  asker: string,
  askerRole?: string,
): GovernanceHooks {
  return {
    ...base,
    async canRead(actor: string, target: GovernanceTarget): Promise<boolean> {
      if (base.canRead) {
        const baseOk = await base.canRead(actor, target);
        if (!baseOk) return false;
      }
      let acl: AccessControl | null;
      try {
        const doc = await source.readDocument(target.documentId);
        acl = parseAccessControl(doc.frontmatter);
      } catch {
        // Document unreadable/absent — ACL layer abstains; base already allowed.
        return true;
      }
      return aclAllows(acl, asker, askerRole);
    },
  };
}
