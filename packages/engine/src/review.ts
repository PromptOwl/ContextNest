/**
 * Human review gate — hold agent/tool writes for a person to approve.
 *
 * A vault opts in with `review: on` in `.context/config.yaml` (`ctx init`
 * writes it for every new vault). The setting is read by the WRITE SURFACES
 * (the CLI's `ctx add`/`ctx update`, the MCP server's create/update tools),
 * which then ask the catalog to hold the write (`review: true` on
 * `context_create` / `context_update`). The engine's own default is
 * unchanged: an embedder that never passes `review: true` publishes exactly
 * as before, whatever the config says.
 *
 * A held write takes one of two shapes, reusing what the engine already has:
 *
 *   - **A node that is not published yet** (a new node, a draft) is written
 *     in place with `status: pending_review`. Nothing unpublished is ever
 *     retrievable, so there is nothing to protect.
 *   - **An edit to a published node** is staged as a suggestion under
 *     `_suggestions/` (the drift machinery, `source: manual-suggestion`, note
 *     prefixed {@link REVIEW_HOLD_NOTE_PREFIX}). The canonical file and the
 *     hash chain are untouched, so the published version keeps serving until
 *     someone approves. A second held edit to the same node builds on the
 *     first and supersedes it, so one approval releases the agent's latest
 *     intent rather than only its first edit.
 *
 * Approval (`approveReview`) performs exactly the write the hold deferred —
 * write the proposed bytes, `publishDocument` (version + checkpoint), regen
 * the index — so an approved hold is indistinguishable from an ungated write.
 *
 * A vault WITHOUT the key predates the gate and keeps publishing, unchanged.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatch } from "diff";
import { parseConfig } from "./config.js";
import { ConfigError, ContextNestError, IntegrityError } from "./errors.js";
import { computeContentHash } from "./integrity.js";
import { getChecksumContent, isPublished, isRejected, serializeDocument } from "./parser.js";
import { publishDocument } from "./publish.js";
import { listSuggestions, readSuggestion, stageSuggestion } from "./suggestions.js";
import { VersionManager } from "./versioning.js";
import { withVaultLock } from "./vault-lock.js";
import { assertSafeDocumentId } from "./storage.js";
import type { NestStorage } from "./storage.js";
import type { GovernanceTier, ReviewMode, SuggestionMeta } from "./types.js";

/** Note prefix that marks a staged suggestion as a review hold (not drift). */
export const REVIEW_HOLD_NOTE_PREFIX = "review-hold";

/** The exact command that turns the gate off — quoted verbatim by every notice. */
export const REVIEW_OFF_COMMAND = "ctx config set review off";

// ─── Setting ────────────────────────────────────────────────────────────────

function configPath(storage: NestStorage): string {
  return join(storage.root, ".context", "config.yaml");
}

/**
 * The vault's review setting: `on`, `off`, or `undefined` for a vault that
 * predates the gate (no key). A vault with no config at all is `undefined`.
 */
export async function readReviewMode(storage: NestStorage): Promise<ReviewMode | undefined> {
  const config = await storage.readConfig();
  return config?.review;
}

/**
 * Set `review:` in `.context/config.yaml`, editing the ONE line in place.
 *
 * Deliberately textual rather than parse → dump: `writeConfig` round-trips
 * through the Zod schema, which strips keys it does not know (a newer
 * engine's, a user's own) and every comment. Here the rest of the file is
 * left byte-for-byte alone, and the result is re-validated before it lands.
 */
export async function setReviewMode(storage: NestStorage, mode: ReviewMode): Promise<void> {
  if (mode !== "on" && mode !== "off") {
    throw new ContextNestError(`review must be "on" or "off", got "${String(mode)}"`, "VALIDATION_FAILED");
  }
  const path = configPath(storage);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`No .context/config.yaml at ${storage.root} — not a Context Nest vault.`);
    }
    throw err;
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  // Quoted: a YAML 1.1 reader would otherwise load a bare on/off as a boolean.
  const line = `review: '${mode}'`;
  const keyLine = /^review:.*$/m;
  let next: string;
  if (keyLine.test(raw)) {
    next = raw.replace(keyLine, line);
  } else {
    next = `${raw}${raw === "" || raw.endsWith("\n") ? "" : eol}${line}${eol}`;
  }
  // Refuse to write a config the engine could not read back.
  const parsed = parseConfig(next);
  if (parsed.review !== mode) {
    throw new ConfigError(`Could not set review in ${path} — edit the file by hand: review: ${mode}`);
  }
  await writeFile(path, next, "utf-8");
}

// ─── Holds (staged edits to published nodes) ────────────────────────────────

/** A staged review hold, with whether the node has moved on since. */
export interface ReviewHold extends SuggestionMeta {
  /** True when the published node changed after staging — approval is refused. */
  stale: boolean;
}

/** Whether a staged suggestion is a review hold rather than detected drift. */
export function isReviewHold(meta: SuggestionMeta): boolean {
  return (
    meta.source === "manual-suggestion" && (meta.note ?? "").startsWith(REVIEW_HOLD_NOTE_PREFIX)
  );
}

/** The exact bytes of the node's latest version (its chain head), or null. */
async function approvedHead(storage: NestStorage, id: string): Promise<string | null> {
  const history = await storage.readHistory(id);
  if (!history || history.versions.length === 0) return null;
  const latest = history.versions[history.versions.length - 1];
  return new VersionManager(storage).reconstructVersion(id, latest.version);
}

/** Review holds staged for one node, oldest first. */
export async function listReviewHolds(storage: NestStorage, id: string): Promise<ReviewHold[]> {
  const metas = (await listSuggestions(storage, id)).filter(isReviewHold);
  if (metas.length === 0) return [];
  const head = await approvedHead(storage, id);
  const headHash = head === null ? null : computeContentHash(getChecksumContent(head));
  return metas.map((m) => ({ ...m, stale: m.target_hash !== headHash }));
}

/**
 * The node's current held proposal — the newest non-stale hold applied to the
 * chain head — or null when nothing is held. A new held edit builds on this.
 */
export async function currentReviewProposal(
  storage: NestStorage,
  id: string,
): Promise<{ suggestionId: string; approvedRaw: string; proposedRaw: string } | null> {
  const holds = (await listReviewHolds(storage, id)).filter((h) => !h.stale);
  if (holds.length === 0) return null;
  const approvedRaw = await approvedHead(storage, id);
  if (approvedRaw === null) return null;
  const newest = holds[holds.length - 1];
  const sug = await readSuggestion(storage, id, newest.suggestion_id);
  if (!sug) return null;
  const proposedRaw = applyPatch(approvedRaw, sug.patch);
  if (typeof proposedRaw !== "string" || proposedRaw === "") return null;
  return { suggestionId: newest.suggestion_id, approvedRaw, proposedRaw };
}

/**
 * Stage an edit to a published node as a review hold. NOT locked — called from
 * inside the locked `context_update` executor (the lock is non-reentrant).
 * Returns null when the node has no version history to diff against; the
 * caller then falls back to an in-place pending write.
 */
export async function stageReviewHold(
  storage: NestStorage,
  input: {
    documentId: string;
    proposedRawContent: string;
    actor: string;
    zone?: string;
    docTier?: GovernanceTier;
    note?: string;
    /** Hold ids this one replaces (archived as rejected: superseded). */
    supersedes?: string[];
  },
): Promise<{ suggestionId: string } | null> {
  const approvedRaw = await approvedHead(storage, input.documentId);
  if (approvedRaw === null) return null;
  const staged = await stageSuggestion({
    storage,
    documentId: input.documentId,
    approvedRawContent: approvedRaw,
    proposedRawContent: input.proposedRawContent,
    source: "manual-suggestion",
    actor: input.actor,
    zone: input.zone,
    docTier: input.docTier ?? "standard",
    note: input.note ? `${REVIEW_HOLD_NOTE_PREFIX}: ${input.note}` : REVIEW_HOLD_NOTE_PREFIX,
  });
  for (const old of input.supersedes ?? []) {
    if (old === staged.meta.suggestion_id) continue;
    await storage.archiveSuggestion(input.documentId, old, "rejected").catch(() => undefined);
  }
  return { suggestionId: staged.meta.suggestion_id };
}

// ─── Listing / approving / rejecting ────────────────────────────────────────

export interface PendingReviewItem {
  id: string;
  title: string;
  /** `new` — an unpublished node awaiting its first publish; `edit` — a held edit to a published node. */
  kind: "new" | "edit";
  /** The hold's suggestion id, for `edit` items. */
  suggestion_id?: string;
  actor?: string;
  held_at?: string;
  stale?: boolean;
}

/** Everything awaiting a reviewer: pending_review nodes plus held edits. */
export async function listPendingReview(storage: NestStorage): Promise<PendingReviewItem[]> {
  const docs = await storage.discoverDocuments();
  const items: PendingReviewItem[] = [];
  for (const doc of docs) {
    if (doc.frontmatter.status === "pending_review") {
      items.push({
        id: doc.id,
        title: doc.frontmatter.title,
        kind: "new",
        ...(doc.frontmatter.updated_at ? { held_at: doc.frontmatter.updated_at } : {}),
      });
      continue;
    }
    if (!isPublished(doc)) continue;
    const holds = await listReviewHolds(storage, doc.id);
    const newest = holds.filter((h) => !h.stale).at(-1) ?? holds.at(-1);
    if (!newest) continue;
    items.push({
      id: doc.id,
      title: doc.frontmatter.title,
      kind: "edit",
      suggestion_id: newest.suggestion_id,
      actor: newest.actor,
      held_at: newest.detected_at,
      stale: newest.stale,
    });
  }
  return items;
}

export interface ReviewDecisionOptions {
  /** Recorded as the version author on approval. */
  actor: string;
  /** Version note recorded on approval. */
  note?: string;
}

export interface ApproveReviewResult {
  id: string;
  version: number;
  checkpoint: number;
  /** Set when a held edit (rather than a pending node) was approved. */
  suggestion_id?: string;
}

/**
 * Approve what is pending for a node: its newest held edit if there is one,
 * otherwise the pending node itself. Takes the vault lock.
 */
export async function approveReview(
  storage: NestStorage,
  id: string,
  opts: ReviewDecisionOptions,
): Promise<ApproveReviewResult> {
  assertSafeDocumentId(id);
  return withVaultLock(storage.root, async () => {
    const holds = await listReviewHolds(storage, id);
    const chosen = holds.filter((h) => !h.stale).at(-1) ?? holds.at(-1);

    if (chosen) {
      if (chosen.stale) {
        throw new IntegrityError(
          `The held edit ${chosen.suggestion_id} for ${id} is stale: the published node changed after it was staged. Reject it and make the edit again.`,
          "content_hash_mismatch",
        );
      }
      const approvedRaw = await approvedHead(storage, id);
      const sug = await readSuggestion(storage, id, chosen.suggestion_id);
      const proposedRaw =
        approvedRaw !== null && sug ? applyPatch(approvedRaw, sug.patch) : false;
      if (typeof proposedRaw !== "string" || proposedRaw === "") {
        throw new IntegrityError(
          `Could not apply the held edit ${chosen.suggestion_id} to ${id}.`,
          "content_hash_mismatch",
        );
      }
      // The write the hold deferred, then the publish it would have done.
      await storage.writeDocument(id, proposedRaw);
      const result = await publishDocument(storage, id, {
        editedBy: opts.actor,
        note: opts.note ?? "Approved held edit",
      });
      await storage.archiveSuggestion(id, chosen.suggestion_id, "approved");
      // Any other hold was staged against the old head and can never apply now.
      for (const other of holds) {
        if (other.suggestion_id === chosen.suggestion_id) continue;
        await storage.archiveSuggestion(id, other.suggestion_id, "rejected").catch(() => undefined);
      }
      await storage.regenerateIndex();
      return {
        id,
        version: result.versionEntry.version,
        checkpoint: result.checkpointNumber,
        suggestion_id: chosen.suggestion_id,
      };
    }

    const node = await storage.readDocument(id);
    if (isPublished(node)) {
      throw new ContextNestError(`Nothing is pending review for ${id} — it is already published.`, "VALIDATION_FAILED");
    }
    if (isRejected(node)) {
      throw new ContextNestError(
        `${id} was rejected. Revive it first: ctx update ${id} --status pending_review`,
        "REJECTED_DOCUMENT",
      );
    }
    const result = await publishDocument(storage, id, {
      editedBy: opts.actor,
      note: opts.note ?? "Approved in review",
    });
    await storage.regenerateIndex();
    return { id, version: result.versionEntry.version, checkpoint: result.checkpointNumber };
  });
}

export interface RejectReviewResult {
  id: string;
  /** `edit` — held edits discarded, published version untouched; `new` — the node was retired (status: rejected). */
  kind: "new" | "edit";
  suggestion_ids?: string[];
}

/**
 * Reject what is pending for a node. Held edits are archived (never deleted —
 * `_suggestions/.../_archive/rejected/`) and the published version keeps
 * serving; a pending node is retired to `status: rejected`, recoverable by
 * setting another status. Takes the vault lock.
 */
export async function rejectReview(
  storage: NestStorage,
  id: string,
  _opts: ReviewDecisionOptions,
): Promise<RejectReviewResult> {
  assertSafeDocumentId(id);
  return withVaultLock(storage.root, async () => {
    const holds = await listReviewHolds(storage, id);
    if (holds.length > 0) {
      for (const h of holds) await storage.archiveSuggestion(id, h.suggestion_id, "rejected");
      return { id, kind: "edit", suggestion_ids: holds.map((h) => h.suggestion_id) };
    }

    const node = await storage.readDocument(id);
    if (isPublished(node) || isRejected(node)) {
      throw new ContextNestError(`Nothing is pending review for ${id}.`, "VALIDATION_FAILED");
    }
    node.frontmatter.status = "rejected";
    node.frontmatter.updated_at = new Date().toISOString();
    await storage.writeDocument(id, serializeDocument(node));
    await storage.regenerateIndex();
    return { id, kind: "new" };
  });
}

/**
 * The one sentence a surface attaches to a held write, for an agent to relay:
 * it is pending, and the user can turn the gate off.
 */
export function reviewHeldMessage(id: string): string {
  return (
    `${id} is pending review, not published — tell the user it is waiting for their approval ` +
    `(\`ctx review approve ${id}\`), and that they can say "turn off review" to have agent writes publish immediately.`
  );
}
