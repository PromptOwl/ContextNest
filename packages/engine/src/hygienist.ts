/**
 * Background hygienist scanner — bridge-function-spec Story 4.2,
 * zone-classification-rbac-spec §3.5.
 *
 * Continuous, non-locking vault traversal that detects out-of-band edits
 * and routes each to the suggestion pipeline. Differs from the checkpoint
 * scanner (step 8) in two ways:
 *
 *   1. **RBAC-scoped.** The scanner runs as a specific actor and never
 *      reads content from a zone that actor cannot ingest
 *      (zone-classification-rbac-spec §4.1, Story 4.2 negative test,
 *      Story 6.2). Cross-zone overlap detection is impossible by design.
 *
 *   2. **Idempotent by default.** A drift already represented by a pending
 *      suggestion (matching `proposed_hash`) is not re-staged on subsequent
 *      ticks — the Czar Inbox does not grow unbounded for the same edit.
 *      Caller can set `skipDocsWithPendingSuggestions: false` to force.
 *
 * Engine guarantees preserved:
 *   - Canonical live file untouched.
 *   - Hash chain head untouched.
 *   - No locks acquired on read/write; if a write races with a scan tick,
 *     the next tick sees the new state (Story 4.2: non-locking traversal).
 */

import type { NestStorage } from "./storage.js";
import type {
  ContextNode,
  GovernanceTier,
  RbacHook,
  SuggestionMeta,
} from "./types.js";
import type { ClassificationManifest } from "./classification.js";
import { classifyDocument } from "./classification.js";
import { stageSuggestion, listSuggestions } from "./suggestions.js";
import { VersionManager } from "./versioning.js";

export interface HygienistInput {
  storage: NestStorage;
  rbac: RbacHook;
  /**
   * Actor identity the scanner runs as. The scanner inherits this actor's
   * ingest permissions (zone-classification-rbac-spec §4.1). For
   * system-scheduled scans, supply a dedicated service identity that the
   * bridge has explicitly authorized for the relevant zones.
   */
  actor: string;
  /** Manifest used to resolve zone/tier when frontmatter lacks them. */
  manifest?: ClassificationManifest;
  /** Default zone for the L3 fallback (see §2.1). */
  defaultZone?: string;
  /** Default governance tier when none is resolved. Defaults to "standard". */
  defaultGovernance?: GovernanceTier;
  /**
   * When true (default), skip a drifted doc if a pending suggestion already
   * exists with the same `proposed_hash`. Set false to force re-stage.
   */
  skipDocsWithPendingSuggestions?: boolean;
}

export interface HygienistEntry {
  documentId: string;
  drifted: boolean;
  staged?: SuggestionMeta;
  skippedReason?: string;
}

export interface HygienistResult {
  scanned: number;
  drifted: number;
  stagedCount: number;
  skippedCount: number;
  /** Subset of skippedCount: docs invisible to this actor under RBAC. */
  permissionFiltered: number;
  entries: HygienistEntry[];
}

/**
 * Run one pass of the background scanner. Returns a structured report;
 * never throws on per-doc failures.
 *
 * Intended to be called on a schedule by the bridge / desktop app. The
 * engine itself does NOT schedule anything — Story 4.2 frames triggers as
 * a bridge concern (scheduled vs. on-demand).
 */
export async function runHygienistScan(
  input: HygienistInput,
): Promise<HygienistResult> {
  const docs = await input.storage.discoverDocuments();
  const entries: HygienistEntry[] = [];
  for (const doc of docs) {
    entries.push(await scanOne(doc, input));
  }
  return {
    scanned: entries.length,
    drifted: entries.filter((e) => e.drifted).length,
    stagedCount: entries.filter((e) => e.staged).length,
    skippedCount: entries.filter((e) => e.skippedReason).length,
    permissionFiltered: entries.filter(
      (e) => e.skippedReason === "no-ingest-permission",
    ).length,
    entries,
  };
}

async function scanOne(
  node: ContextNode,
  input: HygienistInput,
): Promise<HygienistEntry> {
  const documentId = node.id;

  if (!node.frontmatter.checksum) {
    return { documentId, drifted: false, skippedReason: "no-stored-checksum" };
  }

  const resolved = resolveZoneAndTier(node, input);
  if (!resolved) {
    return { documentId, drifted: false, skippedReason: "unresolved-zone" };
  }

  // RBAC gate — Story 4.2 negative test, Story 6.2.
  const canIngest = await input.rbac.canIngest(input.actor, resolved.zone);
  if (!canIngest) {
    return {
      documentId,
      drifted: false,
      skippedReason: "no-ingest-permission",
    };
  }

  const drift = await input.storage.detectDocumentDrift(documentId);
  if (!drift || !drift.drifted) {
    return { documentId, drifted: false };
  }

  // Idempotency: skip if the same drift was already staged.
  if (input.skipDocsWithPendingSuggestions !== false) {
    const existing = await listSuggestions(input.storage, documentId);
    if (existing.some((s) => s.proposed_hash === drift.actualHash)) {
      return {
        documentId,
        drifted: true,
        skippedReason: "already-staged",
      };
    }
  }

  const history = await input.storage.readHistory(documentId);
  if (!history || history.versions.length === 0) {
    return {
      documentId,
      drifted: true,
      skippedReason: "no-version-history",
    };
  }

  let approvedRaw: string;
  try {
    const latest = history.versions[history.versions.length - 1];
    approvedRaw = await new VersionManager(input.storage).reconstructVersion(
      documentId,
      latest.version,
    );
  } catch (err) {
    return {
      documentId,
      drifted: true,
      skippedReason: `chain-head-unreachable: ${(err as Error).message}`,
    };
  }

  const result = await stageSuggestion({
    storage: input.storage,
    documentId,
    approvedRawContent: approvedRaw,
    proposedRawContent: node.rawContent,
    source: "out-of-band-edit",
    actor: input.actor,
    zone: resolved.zone,
    docTier: resolved.governance,
    note: "detected by hygienist scan",
  });

  return { documentId, drifted: true, staged: result.meta };
}

function resolveZoneAndTier(
  node: ContextNode,
  input: HygienistInput,
): { zone: string; governance: GovernanceTier } | null {
  const fmZone = node.frontmatter.zone;
  const fmGov = node.frontmatter.governance;

  if (fmZone && fmGov) {
    return { zone: fmZone, governance: fmGov };
  }

  if (input.manifest) {
    const cls = classifyDocument({
      documentPath: `${node.id}.md`,
      frontmatter: node.frontmatter,
      manifest: input.manifest,
      defaultZone: input.defaultZone ?? "",
    });
    if (cls.zone) {
      return {
        zone: cls.zone,
        governance: cls.governance ?? input.defaultGovernance ?? "standard",
      };
    }
  }

  if (input.defaultZone) {
    return {
      zone: fmZone ?? input.defaultZone,
      governance: fmGov ?? input.defaultGovernance ?? "standard",
    };
  }

  return null;
}
