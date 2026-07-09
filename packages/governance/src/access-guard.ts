/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Access guard — gates node reads with `canUserAccess` when the nest has
 * stewardship enabled. No-op otherwise, so ungoverned nests are unaffected.
 *
 * Decoupled from the community server: identity is the email string, and
 * the per-document/folder share-grant escape hatch (its `grants` table) is
 * not ported — read access here comes from collaborator/steward rows and
 * public visibility only.
 */

import type { GovernanceDb } from "./db/client.js";
import { getNestSettings, isPublicReader } from "./access.js";
import { canUserAccess } from "./stewardship-service.js";
import type { AccessConfig } from "./types.js";

/** Which version of a node is approved (what public readers see), or null. */
export function getApprovedVersion(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
): number | null {
  const row = db
    .prepare(
      "SELECT approved_version FROM approved_versions WHERE nest_id = ? AND node_id = ?",
    )
    .get(nestId, nodeId) as { approved_version: number } | undefined;
  return row?.approved_version ?? null;
}

/**
 * True when the caller can read this node.
 *
 * Resolution order:
 *   1. Public reader (visibility=public, no owner/collab/steward grant) —
 *      only nodes that have an approved version. Drafts/pending stay private.
 *   2. Stewardship disabled — open read.
 *   3. Stewardship enabled — gate via canUserAccess.
 */
export function canReadNode(
  db: GovernanceDb,
  nestId: string,
  nodeId: string,
  userEmail: string,
  access?: AccessConfig | null,
): boolean {
  if (isPublicReader(db, nestId, userEmail, access)) {
    return getApprovedVersion(db, nestId, nodeId) !== null;
  }
  if (!getNestSettings(db, nestId)?.stewardshipEnabled) return true;
  return canUserAccess(db, nestId, nodeId, userEmail, { access }).allowed;
}

/**
 * Filter a list of node-like objects (with `.id`) down to those the caller
 * can read. Mirrors `canReadNode` resolution: public readers see approved
 * nodes only; collaborators bypass the gate when stewardship is off; with
 * stewardship on, each node is gated via canUserAccess.
 */
export function filterAccessible<T extends { id: string }>(
  db: GovernanceDb,
  nestId: string,
  userEmail: string,
  nodes: T[],
  access?: AccessConfig | null,
): T[] {
  if (isPublicReader(db, nestId, userEmail, access)) {
    return nodes.filter(
      (n) => getApprovedVersion(db, nestId, n.id) !== null,
    );
  }
  if (!getNestSettings(db, nestId)?.stewardshipEnabled) return nodes;
  return nodes.filter(
    (n) => canUserAccess(db, nestId, n.id, userEmail, { access }).allowed,
  );
}
