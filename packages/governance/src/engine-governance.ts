/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Engine bridge — adapts this package's stewardship/access services to the
 * engine's `GovernanceBundle` contract, so it can be loaded via the engine's
 * `loadGovernanceBundle()` (env `CONTEXTNEST_GOVERNANCE_MODULE` or vault
 * `.context/config.yaml` `governance.module`).
 *
 * Configuration (env):
 *   - `CONTEXTNEST_GOVERNANCE_DB`      — SQLite file path. Default:
 *     `<vaultPath>/.context/governance.db`; `":memory:"` is allowed
 *     (and is the fallback when no vault path is known).
 *   - `CONTEXTNEST_GOVERNANCE_NEST_ID` — nest id all checks are scoped to.
 *     Default `"default"` (single-vault deployments use one nest id).
 *
 * access.yaml (super admins, groups) is read from `<vaultPath>/.context/`
 * when present.
 *
 * The engine actor IS the caller's email — identity arrives as a plain
 * string and is matched against email-keyed collaborator/steward rows.
 */

import { join } from "node:path";
import type {
  CommitOperation,
  GovernanceBundle,
  GovernanceHooks,
  GovernanceTarget,
  ProvenanceRecord,
  ProvenanceRecorder,
} from "@promptowl/contextnest-engine";
import { openGovernanceDb, type GovernanceDb } from "./db/client.js";
import { loadAccessConfig } from "./access-service.js";
import { canReadNode } from "./access-guard.js";
import { permissionLevel, resolveNestPermission } from "./access.js";
import {
  canCreateInNest,
  canUserApprove,
  canUserEdit,
} from "./stewardship-service.js";
import { logTraceEvent } from "./trace-log.js";
import type { AccessConfig } from "./types.js";

/** Env var naming the governance SQLite file. */
export const GOVERNANCE_DB_ENV = "CONTEXTNEST_GOVERNANCE_DB";
/** Env var naming the nest id all checks are scoped to. */
export const GOVERNANCE_NEST_ID_ENV = "CONTEXTNEST_GOVERNANCE_NEST_ID";

function resolveDbPath(vaultPath?: string): string {
  const fromEnv = process.env[GOVERNANCE_DB_ENV];
  if (fromEnv) return fromEnv;
  if (vaultPath) return join(vaultPath, ".context", "governance.db");
  return ":memory:";
}

/**
 * Build the engine `GovernanceHooks` over an open governance DB.
 *
 * Commit-operation mapping (actor = email):
 *   - `create`                              → `canCreateInNest`
 *   - `update` | `delete` | `stage_suggestion` → `canUserEdit`
 *   - `publish`                             → `canUserEdit` OR `canUserApprove`
 *
 * Publish mapping rationale: in the community system an editor's save on an
 * ungoverned/no-steward document auto-publishes (the save flow, gated by
 * `canUserEdit`, writes the `published` row directly) — so an editor who may
 * edit may publish. Separation of duties applies to the REVIEW workflow
 * (`canUserApprove` blocks approving your own submission), which the engine
 * runs through `approveSuggestion`'s rbac hooks, not through the `publish`
 * commit gate. `canUserApprove` is OR-ed in so a reviewer-only steward
 * (who cannot edit) can still publish an approved revision.
 */
export function buildGovernanceHooks(
  db: GovernanceDb,
  nestId: string,
  access: AccessConfig | null,
): GovernanceHooks {
  const opts = { access };

  return {
    // Czar = nest admin/owner (full governance authority over the zone).
    isCzar(actor: string, _zoneId: string): boolean {
      const perm = resolveNestPermission(db, nestId, actor, access);
      return perm === "owner" || perm === "admin";
    },

    // Ingest requires at least nest-level read.
    canIngest(actor: string, _zoneId: string): boolean {
      return (
        permissionLevel(resolveNestPermission(db, nestId, actor, access)) >=
        permissionLevel("read")
      );
    },

    // Document "ownership" in engine terms = edit rights on the node.
    isDocOwner(actor: string, documentId: string): boolean {
      return canUserEdit(db, nestId, documentId, actor, opts).allowed;
    },

    canRead(actor: string, target: GovernanceTarget): boolean {
      return canReadNode(db, nestId, target.documentId, actor, access);
    },

    canCommit(
      actor: string,
      target: GovernanceTarget,
      operation: CommitOperation,
    ): boolean {
      switch (operation) {
        case "create":
          return canCreateInNest(db, nestId, actor, opts);
        case "publish":
          return (
            canUserEdit(db, nestId, target.documentId, actor, opts).allowed ||
            canUserApprove(db, nestId, target.documentId, actor, opts).allowed
          );
        case "update":
        case "delete":
        case "stage_suggestion":
          return canUserEdit(db, nestId, target.documentId, actor, opts)
            .allowed;
      }
    },
  };
}

/**
 * Build the engine `ProvenanceRecorder` — every record becomes one
 * `api_events` row: kind from `origin.client`, tool from `origin.tool`,
 * user_email from the actor, path from the document id; the provenance
 * event kind ("read" | "commit" | …) lands in `method`.
 */
export function buildProvenanceRecorder(
  db: GovernanceDb,
  nestId: string,
): ProvenanceRecorder {
  return {
    record(rec: ProvenanceRecord): void {
      logTraceEvent(db, {
        kind: rec.origin?.client ?? "engine",
        method: rec.kind,
        path: rec.document_id,
        tool: rec.origin?.tool,
        nestId,
        userEmail: rec.actor,
      });
    },
  };
}

/**
 * Governance module factory — the shape `loadGovernanceBundle` expects.
 * Exported both as a named export and as the default export so either
 * resolution path finds it.
 */
export function createGovernance(ctx: { vaultPath?: string }): GovernanceBundle {
  const db = openGovernanceDb(resolveDbPath(ctx.vaultPath));
  const nestId = process.env[GOVERNANCE_NEST_ID_ENV] || "default";
  const access = ctx.vaultPath
    ? loadAccessConfig(join(ctx.vaultPath, ".context"))
    : null;

  return {
    hooks: buildGovernanceHooks(db, nestId, access),
    recorder: buildProvenanceRecorder(db, nestId),
  };
}

export default createGovernance;
