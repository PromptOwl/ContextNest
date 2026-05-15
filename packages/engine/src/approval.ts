/**
 * Approval / rejection / rollback / Czar direct-edit primitives — the
 * only paths in the engine that mutate the hash chain or the canonical
 * live document.
 *
 * Spec coverage:
 *   - bridge-function-spec §5 Stages 2–4: gatekeeper approval, direct edit,
 *     publishing, audit trail
 *   - bridge-function-spec Story 3.2: gatekeeper approval workflow
 *   - bridge-function-spec Story 3.3: instant rollback
 *   - zone-classification-rbac-spec §6: every governance action emits a
 *     first-class hash chain event
 *   - hootie-inbox-spec §4.1 / §4.2 / §8: approve / reject / alter /
 *     rollback semantics and chain integration
 *
 * Engine guarantees:
 *   - No path here trusts the actor — every mutation routes through the
 *     injected `RbacHook` (`requireCzar` for Primary, `requireDocOwner` for
 *     Standard).
 *   - No path auto-merges a stale suggestion. If the chain head has moved
 *     since staging, the approval is refused with an `IntegrityError` so
 *     the caller can re-stage against the new head.
 *   - No suggestion data is ever deleted. Approved / rejected suggestions
 *     are moved (not unlinked) into `_archive/{approved|rejected}/`
 *     (hootie-inbox-spec §7 — governance history permanently retained).
 */

import { join } from "node:path";
import { applyPatch } from "diff";
import { parseDocument, serializeDocument } from "./parser.js";
import { computeContentHash } from "./integrity.js";
import { getChecksumContent } from "./parser.js";
import { VersionManager } from "./versioning.js";
import { readSuggestion } from "./suggestions.js";
import {
  requireCzar,
  requireDocOwner,
} from "./rbac.js";
import {
  DocumentNotFoundError,
  IntegrityError,
} from "./errors.js";
import type {
  ContextNode,
  GovernanceTier,
  HashChainEvent,
  HashChainEventType,
  RbacHook,
  VersionEntry,
} from "./types.js";
import type { NestStorage } from "./storage.js";

/** Inputs common to every governance action. */
interface BaseInput {
  storage: NestStorage;
  rbac: RbacHook;
  documentId: string;
  /** Opaque actor string supplied by the bridge. Engine never interprets. */
  actor: string;
  /** Zone the document belongs to. Required for the Czar gate (Primary tier). */
  zone: string;
}

export interface ApproveSuggestionInput extends BaseInput {
  suggestionId: string;
  /** Optional approval comment recorded in the chain event audit metadata. */
  comment?: string;
}

export interface ApprovalResult {
  versionEntry: VersionEntry;
  chainEvent: HashChainEvent;
  /** Absolute path to the archive directory the suggestion files were moved to. */
  archivedAt: string;
}

/**
 * Approve a staged suggestion: applies the patch, commits a new version,
 * writes the live canonical file, and archives the suggestion record.
 *
 * Refuses if the suggestion's `target_hash` no longer equals the current
 * chain head (suggestion is stale; caller must re-stage).
 */
export async function approveSuggestion(
  input: ApproveSuggestionInput,
): Promise<ApprovalResult> {
  const sug = await readSuggestion(
    input.storage,
    input.documentId,
    input.suggestionId,
  );
  if (!sug) {
    throw new DocumentNotFoundError(
      `suggestion:${input.documentId}/${input.suggestionId}`,
    );
  }

  await gateForTier(input.rbac, sug.meta.doc_tier, {
    actor: input.actor,
    zone: input.zone,
    documentId: input.documentId,
    action: "approveSuggestion",
  });

  const approved = await loadApprovedBase(input.storage, input.documentId);
  await assertNotStale(approved.content, sug.meta.target_hash, input.suggestionId);

  const patched = applyPatch(approved.content, sug.patch);
  if (typeof patched !== "string" || patched === "") {
    throw new IntegrityError(
      `Failed to apply suggestion "${input.suggestionId}" to current approved content`,
      "content_hash_mismatch",
    );
  }

  const { versionEntry } = await commitNewVersion({
    storage: input.storage,
    documentId: input.documentId,
    newRawContent: patched,
    actor: input.actor,
    note: input.comment,
  });

  const archivedAt = await input.storage.archiveSuggestion(
    input.documentId,
    input.suggestionId,
    "approved",
  );

  const eventType: HashChainEventType =
    sug.meta.doc_tier === "primary"
      ? "primary.approved"
      : "standard.owner_approved";

  const chainEvent = buildChainEvent({
    eventType,
    actor: input.actor,
    zone: input.zone,
    documentId: input.documentId,
    versionEntry,
    metadata: {
      suggestion_id: input.suggestionId,
      source: sug.meta.source,
      target_hash: sug.meta.target_hash,
      proposed_hash: sug.meta.proposed_hash,
      ...(input.comment ? { approval_comment: input.comment } : {}),
    },
  });

  return { versionEntry, chainEvent, archivedAt };
}

export interface RejectSuggestionInput extends BaseInput {
  suggestionId: string;
  /** Required per bridge §5 Stage 3: rejection must carry a reason for audit. */
  reason: string;
}

export interface RejectionResult {
  chainEvent: HashChainEvent;
  archivedAt: string;
}

/**
 * Reject a staged suggestion (bridge-function-spec §5 Stage 3, hootie §7).
 *
 * Canonical document and chain head are untouched. The suggestion files
 * are MOVED (not deleted) into `_archive/rejected/` — per spec, governance
 * history is permanently retained.
 */
export async function rejectSuggestion(
  input: RejectSuggestionInput,
): Promise<RejectionResult> {
  if (!input.reason.trim()) {
    throw new IntegrityError(
      "Rejection requires a non-empty reason (bridge §5 Stage 3)",
      "content_hash_mismatch",
    );
  }

  const sug = await readSuggestion(
    input.storage,
    input.documentId,
    input.suggestionId,
  );
  if (!sug) {
    throw new DocumentNotFoundError(
      `suggestion:${input.documentId}/${input.suggestionId}`,
    );
  }

  await gateForTier(input.rbac, sug.meta.doc_tier, {
    actor: input.actor,
    zone: input.zone,
    documentId: input.documentId,
    action: "rejectSuggestion",
  });

  const archivedAt = await input.storage.archiveSuggestion(
    input.documentId,
    input.suggestionId,
    "rejected",
  );

  // Rejection still emits a chain event (hootie §8 — Czar decisions are
  // chain events regardless of outcome). No resulting content hash since
  // canonical state did not change.
  const chainEvent: HashChainEvent = {
    event_id: makeEventId(input.suggestionId, "rejected"),
    event_type:
      sug.meta.doc_tier === "primary"
        ? "primary.rejected"
        : // Spec gives owners "approve / alter / rollback" — no explicit
          // standard rejection event. Closest fit is alter to "no change",
          // which is semantically a content-preserving owner decision.
          "standard.owner_altered",
    timestamp: new Date().toISOString(),
    actor: input.actor,
    zone: input.zone,
    document_id: input.documentId,
    action_metadata: {
      suggestion_id: input.suggestionId,
      source: sug.meta.source,
      rejection_reason: input.reason,
    },
  };

  return { chainEvent, archivedAt };
}

export interface RollbackInput extends BaseInput {
  /** Version to revert TO (must be a prior keyframe in history). */
  targetVersion: number;
  docTier: GovernanceTier;
  reason?: string;
}

export interface RollbackResult {
  versionEntry: VersionEntry;
  chainEvent: HashChainEvent;
}

/**
 * One-click instant revert (bridge-function-spec Story 3.3, §5 Resolved §4).
 *
 * Rolls forward — the revert is recorded as a NEW version pointing at the
 * prior content. Prior versions are not erased; the chain reads cleanly
 * forward to the rollback entry, then to whatever comes after.
 */
export async function rollbackDocument(
  input: RollbackInput,
): Promise<RollbackResult> {
  await gateForTier(input.rbac, input.docTier, {
    actor: input.actor,
    zone: input.zone,
    documentId: input.documentId,
    action: "rollbackDocument",
  });

  const vm = new VersionManager(input.storage);
  const targetContent = await vm.reconstructVersion(
    input.documentId,
    input.targetVersion,
  );

  const { versionEntry } = await commitNewVersion({
    storage: input.storage,
    documentId: input.documentId,
    newRawContent: targetContent,
    actor: input.actor,
    note: input.reason
      ? `rollback to v${input.targetVersion}: ${input.reason}`
      : `rollback to v${input.targetVersion}`,
  });

  const eventType: HashChainEventType =
    input.docTier === "primary"
      ? "primary.rolled_back"
      : "standard.owner_rolled_back";

  const chainEvent = buildChainEvent({
    eventType,
    actor: input.actor,
    zone: input.zone,
    documentId: input.documentId,
    versionEntry,
    metadata: {
      target_version: input.targetVersion,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  return { versionEntry, chainEvent };
}

export interface CzarDirectEditInput extends BaseInput {
  /**
   * The full new raw markdown content (frontmatter + body). The engine
   * recomputes the body checksum and bumps the version automatically.
   */
  newRawContent: string;
  note?: string;
}

export interface CzarDirectEditResult {
  versionEntry: VersionEntry;
  chainEvent: HashChainEvent;
}

/**
 * Czar proactive direct edit (bridge-function-spec §5 Stage 2 Proactive).
 *
 * No suggestion layer. Czar's signature is auto-recorded. Subscribers see
 * it as a direct publication (chain event = `primary.approved`).
 */
export async function czarDirectEdit(
  input: CzarDirectEditInput,
): Promise<CzarDirectEditResult> {
  await requireCzar(input.rbac, input.actor, input.zone, "czarDirectEdit");

  const { versionEntry } = await commitNewVersion({
    storage: input.storage,
    documentId: input.documentId,
    newRawContent: input.newRawContent,
    actor: input.actor,
    note: input.note ?? "czar direct edit",
  });

  const chainEvent = buildChainEvent({
    eventType: "primary.approved",
    actor: input.actor,
    zone: input.zone,
    documentId: input.documentId,
    versionEntry,
    metadata: {
      direct_edit: true,
      ...(input.note ? { note: input.note } : {}),
    },
  });

  return { versionEntry, chainEvent };
}

// --- internals ------------------------------------------------------------

async function gateForTier(
  rbac: RbacHook,
  tier: GovernanceTier,
  ctx: { actor: string; zone: string; documentId: string; action: string },
): Promise<void> {
  if (tier === "primary") {
    await requireCzar(rbac, ctx.actor, ctx.zone, ctx.action);
  } else {
    await requireDocOwner(rbac, ctx.actor, ctx.documentId, ctx.action);
  }
}

async function loadApprovedBase(
  storage: NestStorage,
  documentId: string,
): Promise<{ version: number; content: string }> {
  // The approved base is the EXACT current chain head — last keyframe plus
  // any diffs applied forward. `readLatestApprovedKeyframe` alone would
  // skip non-keyframe entries and let stale suggestions slip through.
  const history = await storage.readHistory(documentId);
  if (!history || history.versions.length === 0) {
    throw new DocumentNotFoundError(`approved-keyframe:${documentId}`);
  }
  const latest = history.versions[history.versions.length - 1];
  const content = await new VersionManager(storage).reconstructVersion(
    documentId,
    latest.version,
  );
  return { version: latest.version, content };
}

async function assertNotStale(
  approvedContent: string,
  targetHashAtStaging: string,
  suggestionId: string,
): Promise<void> {
  const currentHead = computeContentHash(getChecksumContent(approvedContent));
  if (currentHead !== targetHashAtStaging) {
    throw new IntegrityError(
      `Suggestion "${suggestionId}" is stale: target_hash ${targetHashAtStaging} no longer matches current chain head ${currentHead}`,
      "content_hash_mismatch",
    );
  }
}

interface CommitInput {
  storage: NestStorage;
  documentId: string;
  newRawContent: string;
  actor: string;
  note?: string;
}

async function commitNewVersion(
  input: CommitInput,
): Promise<{ versionEntry: VersionEntry; serialized: string }> {
  const filePath = join(input.storage.root, `${input.documentId}.md`);
  const parsed = parseDocument(filePath, input.newRawContent, input.documentId);

  const newVersion = (parsed.frontmatter.version ?? 0) + 1;
  const updatedAt = new Date().toISOString();
  const node: ContextNode = {
    ...parsed,
    frontmatter: {
      ...parsed.frontmatter,
      version: newVersion,
      updated_at: updatedAt,
    },
  };

  // Recompute body checksum on the body-as-it-will-be-serialized so the
  // checksum stored in frontmatter matches what later drift detection
  // computes. We serialize once for hashing input to keep it stable.
  const preSerialized = serializeDocument(node);
  const newBodyHash = computeContentHash(getChecksumContent(preSerialized));
  node.frontmatter.checksum = newBodyHash;

  const serialized = serializeDocument(node);
  const finalNode: ContextNode = { ...node, rawContent: serialized };

  const versionEntry = await new VersionManager(input.storage).createVersion(
    finalNode,
    input.actor,
    {
      note: input.note,
      publishedAt: updatedAt,
    },
  );

  // Write the live canonical file last so a mid-flight crash leaves the
  // chain consistent (history wrote first, live file matches the chain
  // head only after this succeeds).
  await input.storage.writeDocument(input.documentId, serialized);

  return { versionEntry, serialized };
}

function buildChainEvent(args: {
  eventType: HashChainEventType;
  actor: string;
  zone: string;
  documentId: string;
  versionEntry: VersionEntry;
  metadata?: Record<string, unknown>;
}): HashChainEvent {
  return {
    event_id: makeEventId(args.documentId, args.eventType, args.versionEntry.version),
    event_type: args.eventType,
    timestamp: args.versionEntry.edited_at,
    actor: args.actor,
    zone: args.zone,
    document_id: args.documentId,
    resulting_hash: args.versionEntry.chain_hash,
    action_metadata: args.metadata,
  };
}

function makeEventId(...parts: Array<string | number>): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `evt_${ts}_${parts.join("_")}`;
}
