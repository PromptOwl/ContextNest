/**
 * RBAC enforcement primitives for the Context Nest engine.
 *
 * The engine is identity-agnostic by design. It never assumes who the actor
 * is or what permissions they hold; the bridge layer supplies an `RbacHook`
 * implementation that wraps the org's real identity/permission service.
 *
 * Two parallel surfaces are supported on `RbacHook` (both optional, see
 * `types.ts`):
 *   - Generic: `canEdit(actor, docId)` + `canApprove(actor, docId)` — the
 *     conventional editor/reviewer model most apps use.
 *   - Zone model: `isCzar(actor, zone)` + `canIngest(actor, zone)` +
 *     `isDocOwner(actor, docId)` — PromptOwl's zone/Czar terminology
 *     (zone-classification-rbac-spec §4). Kept first-class so existing
 *     deployments and OSS consumers who want a tier-aware model can opt in.
 *
 * What lives here:
 *   - `denyAllRbac`: safe default that denies every check.
 *   - `requireCzar` / `requireIngest` / `requireDocOwner`: zone-model
 *     assertion helpers.
 *   - `requireEdit` / `requireApprove`: generic assertion helpers.
 *
 * Engine code that performs a governance-class action MUST route the
 * permission decision through one of these helpers — it must NOT inspect
 * actor strings, role tables, or anything identity-shaped.
 *
 * Missing methods on the hook are treated as "deny". Use the helper that
 * matches the surface you wired up; mixing models silently denies.
 */

import type { RbacHook } from "./types.js";
import { UnauthorizedActionError } from "./errors.js";

/**
 * Default-deny RBAC hook. Every check returns `false`.
 *
 * This is the engine's safe baseline: if no bridge-supplied hook is wired
 * up, governance-class operations cannot succeed. The engine never assumes
 * an unauthenticated context is trusted.
 */
export const denyAllRbac: RbacHook = {
  canEdit: () => false,
  canApprove: () => false,
  isCzar: () => false,
  canIngest: () => false,
  isDocOwner: () => false,
};

async function callOrDeny(
  fn: ((...args: any[]) => boolean | Promise<boolean>) | undefined,
  ...args: unknown[]
): Promise<boolean> {
  if (!fn) return false;
  return Boolean(await fn(...args));
}

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
  const ok = await callOrDeny(hook.isCzar, actor, zoneId);
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
  const ok = await callOrDeny(hook.canIngest, actor, zoneId);
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
  const ok = await callOrDeny(hook.isDocOwner, actor, documentId);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action);
  }
}

/**
 * Generic editor gate: assert the actor may edit / submit changes to the
 * given document. Throws `UnauthorizedActionError` otherwise.
 *
 * Use this when the consumer wires up the conventional `canEdit` surface
 * instead of the zone-classification model. Most non-PromptOwl deployments
 * will route here.
 */
export async function requireEdit(
  hook: RbacHook,
  actor: string,
  documentId: string,
  action: string,
): Promise<void> {
  const ok = await callOrDeny(hook.canEdit, actor, documentId);
  if (!ok) {
    throw new UnauthorizedActionError(actor, action);
  }
}

/**
 * Generic reviewer gate: assert the actor may approve / publish the given
 * document. Throws `UnauthorizedActionError` otherwise.
 *
 * Use this when the consumer wires up the conventional `canApprove`
 * surface instead of the zone-classification model.
 */
export async function requireApprove(
  hook: RbacHook,
  actor: string,
  documentId: string,
  action: string,
): Promise<void> {
  const ok = await callOrDeny(hook.canApprove, actor, documentId);
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
      allowed: await callOrDeny(hook.canIngest, actor, zoneId),
    })),
  );
  return checks.filter((c) => c.allowed).map((c) => c.zoneId);
}
