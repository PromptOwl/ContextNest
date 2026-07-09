/**
 * RBAC enforcement primitives for the Context Nest engine.
 *
 * The engine is identity-agnostic by design (zone-classification-rbac-spec
 * §4, bridge-function-spec Story 6.2). It never assumes who the actor is or
 * what permissions they hold; the bridge layer supplies an `RbacHook`
 * implementation that wraps the org's real identity/permission service.
 *
 * What lives here:
 *   - `denyAllRbac`: a safe default that denies every operation. Used when
 *     no hook is supplied so unwrapped engine usage cannot escalate.
 *   - `requireCzar` / `requireIngest` / `requireDocOwner`: small assertion
 *     helpers that throw `UnauthorizedActionError` on a denied check.
 *
 * Engine code that performs a governance-class action (approve, reject,
 * rollback, force-push, dream-approve, classification-manifest-update, etc.)
 * MUST route the permission decision through one of these helpers — it must
 * NOT inspect actor strings, role tables, or anything identity-shaped.
 */

import type {
  CommitOperation,
  GovernanceHooks,
  GovernanceTarget,
  RbacHook,
} from "./types.js";
import { UnauthorizedActionError } from "./errors.js";

/**
 * Default-deny RBAC hook. Every check returns `false`.
 *
 * This is the engine's safe baseline: if no bridge-supplied hook is wired
 * up, governance-class operations cannot succeed. The engine never assumes
 * an unauthenticated context is trusted.
 */
export const denyAllRbac: RbacHook = {
  isCzar: () => false,
  canIngest: () => false,
  isDocOwner: () => false,
};

/**
 * Assert the actor is the Czar of the given zone. Throws
 * `UnauthorizedActionError` otherwise.
 *
 * Use before any action listed under zone-classification-rbac-spec §5.4
 * "Czar authorities" — approve/reject primary changes, grant/revoke
 * ingest, trigger force push, approve dream proposals, resolve zone
 * challenges, edit the classification manifest, etc.
 */
export async function requireCzar(
  hook: RbacHook,
  actor: string,
  zoneId: string,
  action: string,
): Promise<void> {
  const ok = await hook.isCzar(actor, zoneId);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action, zoneId);
  }
}

/**
 * Assert the actor has ingest permission for the given zone. Throws
 * `UnauthorizedActionError` otherwise.
 *
 * Per zone-classification-rbac-spec §4.1, ingest is the single, binary
 * permission. If you do not have ingest on a zone, the zone does not exist
 * for you — never enumerate documents, never resolve URIs, never include
 * docs in scanner results (Story 4.2 negative test, Story 6.2).
 */
export async function requireIngest(
  hook: RbacHook,
  actor: string,
  zoneId: string,
  action: string,
): Promise<void> {
  const ok = await hook.canIngest(actor, zoneId);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action, zoneId);
  }
}

/**
 * Assert the actor owns the document. Throws `UnauthorizedActionError`
 * otherwise.
 *
 * Use before Standard Document owner-only actions: approve, alter, or
 * rollback an incoming change notification (hootie-inbox-spec §4.2).
 */
export async function requireDocOwner(
  hook: RbacHook,
  actor: string,
  documentId: string,
  action: string,
): Promise<void> {
  const ok = await hook.isDocOwner(actor, documentId);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action);
  }
}

/**
 * Filter a list of zone IDs down to the subset the actor can ingest.
 *
 * Used by the background scanner / hygienist before traversing zones — per
 * Story 4.2 negative test, the scanner MUST NOT cross zone boundaries to
 * find content the user lacks ingest permission for. Zones the actor
 * cannot ingest are silently elided; zone existence is not disclosed
 * (§3.2 isolation by default).
 */
export async function filterIngestibleZones(
  hook: RbacHook,
  actor: string,
  zoneIds: readonly string[],
): Promise<string[]> {
  const checks = await Promise.all(
    zoneIds.map(async (zoneId) => ({
      zoneId,
      allowed: await hook.canIngest(actor, zoneId),
    })),
  );
  return checks.filter((c) => c.allowed).map((c) => c.zoneId);
}

/**
 * Deny-everything governance bundle including the user-level read/commit
 * gates. The explicit safe baseline for deployments that want closed-by-
 * default behavior.
 */
export const denyAllGovernance: GovernanceHooks = {
  ...denyAllRbac,
  canRead: () => false,
  canCommit: () => false,
};

/**
 * Allow-everything governance bundle for local single-user contexts. This is
 * what the CLI and MCP server fall back to when no governance module is
 * loaded — identical to the ungated behavior that existed before these seams.
 */
export const allowAllGovernance: GovernanceHooks = {
  isCzar: () => true,
  canIngest: () => true,
  isDocOwner: () => true,
  canRead: () => true,
  canCommit: () => true,
};

/**
 * Assert the actor may read the target document. Absent hooks, absent
 * `canRead`, or absent actor mean ALLOW (reads were ungated before this
 * seam; gating is opt-in per call). Throws `UnauthorizedActionError` on an
 * explicit deny.
 */
export async function requireRead(
  hooks: GovernanceHooks | undefined,
  actor: string | undefined,
  target: GovernanceTarget,
  action: string,
): Promise<void> {
  if (!hooks?.canRead || actor === undefined) return;
  const ok = await hooks.canRead(actor, target);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action, target.zone);
  }
}

/**
 * Assert the actor may perform a mutation (`create`/`update`/`delete`/
 * `publish`/`stage_suggestion`) on the target document. Absent hooks, absent
 * `canCommit`, or absent actor mean ALLOW. Throws `UnauthorizedActionError`
 * on an explicit deny.
 */
export async function requireCommit(
  hooks: GovernanceHooks | undefined,
  actor: string | undefined,
  target: GovernanceTarget,
  operation: CommitOperation,
  action: string,
): Promise<void> {
  if (!hooks?.canCommit || actor === undefined) return;
  const ok = await hooks.canCommit(actor, target, operation);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action, target.zone);
  }
}

/**
 * Filter a node list down to those the actor may read. Batch/silent
 * counterpart of `requireRead` — denied nodes are elided, never thrown on
 * (mirrors the community access-guard's `filterAccessible` semantics).
 * Absent hooks/`canRead`/actor → identity. Order is preserved.
 */
export async function filterReadable<T extends { id: string }>(
  hooks: GovernanceHooks | undefined,
  actor: string | undefined,
  nodes: readonly T[],
  zoneOf?: (node: T) => string | undefined,
): Promise<T[]> {
  if (!hooks?.canRead || actor === undefined) return [...nodes];
  const canRead = hooks.canRead.bind(hooks);
  const checks = await Promise.all(
    nodes.map(async (node) => ({
      node,
      allowed: await canRead(actor, {
        documentId: node.id,
        zone: zoneOf?.(node),
      }),
    })),
  );
  return checks.filter((c) => c.allowed).map((c) => c.node);
}
