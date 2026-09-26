/**
 * The forget protocol (§6.3): erasure that leaves verification intact.
 *
 * Append-only, hash-chained history is what makes a memory trustworthy and
 * exactly what makes erasure hard: deleting a version breaks every chain hash
 * after it, and deleting a file leaves the content alive in keyframes and
 * diffs. A forget does neither. For every version of the node it deletes the
 * stored content (keyframe / diff / archived binary) and keeps the entry's
 * `content_hash` and `chain_hash` unchanged, marking it `tombstone: true`.
 * Because `chain_hash[n]` is computed from `content_hash[n]`, never from the
 * content, every later entry still verifies; verification treats a tombstoned
 * entry as hash-only. The chain proves something existed, when and by whom —
 * no longer what.
 *
 * The live file becomes an empty stub with `status: forgotten`, sealed as a
 * new keyframe version plus a checkpoint — a forget is a content-publishing
 * operation, so the boundary is on the record. A `document.forgotten` event is
 * appended to the chain-event log: who, when, under which reason code, which
 * versions — and, as hashes only, which content — so anti-resurrection
 * (tombstones.ts) can refuse a pre-forget copy wherever it turns up. The
 * reason is a closed code; free text never enters the record.
 *
 * `ctx delete` goes through the same record (`deleteDocumentWithTombstone`):
 * the node is removed outright, but a tombstone stays behind so the deletion
 * cannot be silently undone.
 *
 * Not implemented here (spec §6.3.2 range forget, §6.3.4 lineage flags,
 * §6.3.5 retention keys): see CONTEXT_NEST_SPEC.md §6.3 "Not yet implemented".
 */

import type {
  ClientMetadata,
  ContextNode,
  DocumentHistory,
  ForgetReasonCode,
  Frontmatter,
  HashChainEvent,
  VersionEntry,
} from "./types.js";
import type { NestStorage } from "./storage.js";
import { assertSafeDocumentId } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
import { ChainEventLog } from "./chain-log.js";
import { FORGET_REASON_CODES } from "./schemas.js";
import {
  getChecksumContent,
  isForgotten,
  parseDocument,
  serializeDocument,
} from "./parser.js";
import { computeContentHash } from "./integrity.js";
import { ContextNestError, ForgottenDocumentError } from "./errors.js";
import {
  FORGET_EVENT_TYPE,
  addTombstone,
  forgettableBodyHash,
  isPathForgotten,
  tombstoneFromEvent,
  type TombstoneIndex,
  type TombstoneRecord,
} from "./tombstones.js";

export interface ForgetOptions {
  /** Closed reason code (§6.3.1) — never free text. */
  reasonCode: ForgetReasonCode;
  /** Actor performing the forget; recorded as `forgotten_by` and on the event. */
  forgottenBy: string;
  /** Who asked for it (data subject, steward, regulator) — an identity, not a reason. */
  requestedBy?: string;
  /** Caller metadata for the stub's version entry (§9.4). Never hashed. */
  client?: ClientMetadata;
  /**
   * Internal: re-apply a forget already recorded elsewhere (an imported
   * tombstone) instead of recording a new event.
   */
  replay?: TombstoneRecord;
}

export interface ForgetResult {
  id: string;
  /** Version numbers whose content was erased. */
  versions: number[];
  /** The version the empty stub was sealed as. */
  stubVersion: number;
  /** The checkpoint the forget cut. */
  checkpoint: number;
  /** The recorded event, or null on a replay. */
  event: HashChainEvent | null;
}

const REASONS = new Set<string>(FORGET_REASON_CODES);

function assertReason(code: string): void {
  if (!REASONS.has(code)) {
    throw new ContextNestError(
      `Unknown reason "${code}" — use one of ${FORGET_REASON_CODES.join(", ")}`,
      "VALIDATION_FAILED",
      "§6.3.1",
    );
  }
}

/** Frontmatter keys a forgotten stub keeps: the eight governance keys plus the
 *  structural blocks its type requires to stay valid, and access scoping. */
const STUB_KEYS: ReadonlyArray<keyof Frontmatter> = [
  "title",
  "type",
  "tags",
  "created_at",
  // Required by the node's type (§13 rules 9/18/25) — a stub that failed
  // validation would be a stub nothing could read.
  "source",
  "skill",
  "pdf",
  // Access scoping, not content.
  "zone",
  "governance",
];

/**
 * Hashes of everything a node has held — the live body, every version's body
 * and every pdf binary — gathered before it is erased. A version that no
 * longer reconstructs contributes nothing; its content_hash still names it.
 */
async function collectErasedHashes(
  storage: NestStorage,
  node: ContextNode,
  entries: readonly VersionEntry[],
): Promise<{ bodyHashes: string[]; pdfHashes: string[] }> {
  const bodies = new Set<string>();
  const pdfs = new Set<string>();
  const note = (raw: string) => {
    const h = forgettableBodyHash(raw);
    if (h) bodies.add(h);
    try {
      const sha = parseDocument(`${node.id}.md`, raw, node.id).frontmatter.pdf?.sha256;
      if (typeof sha === "string") pdfs.add(sha);
    } catch {
      // Unparseable revision: no pdf block to record.
    }
  };
  note(node.rawContent);
  const vm = new VersionManager(storage);
  for (const entry of entries) {
    try {
      note(await vm.reconstructVersion(node.id, entry.version));
    } catch {
      // Unreconstructable already — nothing more to record than its hash.
    }
  }
  return { bodyHashes: [...bodies], pdfHashes: [...pdfs] };
}

/**
 * Forget a node (§6.3.3). Not locked here — the `context_forget` executor
 * takes the vault write lock, like every other mutating operation.
 */
export async function forgetDocument(
  storage: NestStorage,
  docId: string,
  options: ForgetOptions,
): Promise<ForgetResult> {
  assertSafeDocumentId(docId);
  assertReason(options.reasonCode);
  const node = await storage.readDocument(docId);
  const history = await storage.readHistory(docId);
  return forgetNode(storage, node, history, options);
}

async function forgetNode(
  storage: NestStorage,
  node: ContextNode,
  history: DocumentHistory | null,
  options: ForgetOptions,
): Promise<ForgetResult> {
  const docId = node.id;
  if (isForgotten(node)) throw new ForgottenDocumentError(docId, "is already forgotten");

  const vm = new VersionManager(storage);
  const forgottenAt = options.replay?.forgotten_at ?? new Date().toISOString();
  const entries = history?.versions ?? [];
  const erased = entries.filter((e) => !e.tombstone);
  const { bodyHashes, pdfHashes } = await collectErasedHashes(storage, node, erased);

  // Tombstone first, erase second: a crash in between leaves artifacts behind
  // a tombstone — loud (`forgotten_content_present`) — never a live entry whose
  // content is silently missing.
  if (history) {
    for (const entry of erased) {
      delete entry.diff;
      // Free text written at edit time can quote the content. It is not
      // hashed, so it goes with the content.
      delete entry.note;
      entry.tombstone = true;
      entry.forgotten_at = forgottenAt;
      entry.forgotten_by = options.replay?.forgotten_by ?? options.forgottenBy;
      entry.reason_code = options.replay?.reason_code ?? options.reasonCode;
    }
    await storage.writeHistory(docId, history);
  }
  for (const entry of entries) await storage.removeVersionArtifacts(docId, entry.version);
  await storage.removeArchivedPdfs(docId);
  await storage.removeSuggestions(docId);
  const sidecar = node.frontmatter.pdf?.file;
  if (node.frontmatter.type === "pdf" && sidecar === `${docId}.pdf`) {
    await storage.removeVaultFile(sidecar);
  }

  // The stub: the eight keys, `status: forgotten`, an empty body.
  const stubVersion = await vm.nextVersion(docId, node.frontmatter.version || 0);
  const frontmatter: Frontmatter = { title: node.frontmatter.title };
  for (const key of STUB_KEYS) {
    const value = node.frontmatter[key];
    if (value !== undefined) (frontmatter as unknown as Record<string, unknown>)[key] = value;
  }
  frontmatter.status = "forgotten";
  frontmatter.version = stubVersion;
  frontmatter.updated_at = forgottenAt;
  const stub: ContextNode = { ...node, frontmatter, body: "", rawContent: "" };
  frontmatter.checksum = computeContentHash(getChecksumContent(serializeDocument(stub)));
  await storage.writeDocument(docId, serializeDocument(stub));

  // Sealed as a keyframe: a diff against the erased content would carry its
  // lines as `-` context, which is the one place a forget must not leave them.
  const sealed = await vm.createVersion(await storage.readDocument(docId), options.forgottenBy, {
    publishedAt: forgottenAt,
    keyframe: true,
    forgetStub: true,
    ...(options.client ? { client: options.client } : {}),
  });

  // A forget is a content-publishing operation (§6.3.4): it cuts a checkpoint.
  // The forgotten node is no longer published, so it drops out of the map.
  const checkpoint = await new CheckpointManager(storage).createCheckpointFromVault(docId);

  const event = options.replay
    ? null
    : await record(storage, {
        docId,
        mode: "forget",
        versions: erased.map((e) => e.version),
        at: forgottenAt,
        actor: options.forgottenBy,
        reasonCode: options.reasonCode,
        requestedBy: options.requestedBy,
        resultingHash: sealed.chain_hash,
        stubVersion: sealed.version,
        checkpoint: checkpoint.checkpoint,
        contentHashes: erased.map((e) => e.content_hash),
        bodyHashes,
        pdfHashes,
      });

  return {
    id: docId,
    versions: erased.map((e) => e.version),
    stubVersion: sealed.version,
    checkpoint: checkpoint.checkpoint,
    event,
  };
}

async function record(
  storage: NestStorage,
  args: {
    docId: string;
    mode: "forget" | "delete";
    versions: number[];
    at: string;
    actor: string;
    reasonCode: ForgetReasonCode;
    requestedBy?: string;
    resultingHash?: string;
    stubVersion?: number;
    checkpoint?: number;
    contentHashes: string[];
    bodyHashes: string[];
    pdfHashes: string[];
  },
): Promise<HashChainEvent> {
  const event: HashChainEvent = {
    event_id: `evt_${args.at.replace(/[:.]/g, "-")}_${args.docId}_${args.mode === "delete" ? "deleted" : "forgotten"}`,
    event_type: FORGET_EVENT_TYPE,
    timestamp: args.at,
    actor: args.actor,
    document_id: args.docId,
    ...(args.resultingHash ? { resulting_hash: args.resultingHash } : {}),
    action_metadata: {
      scope: "node",
      mode: args.mode,
      versions: args.versions,
      reason_code: args.reasonCode,
      ...(args.requestedBy ? { requested_by: args.requestedBy } : {}),
      forgotten_at: args.at,
      ...(args.stubVersion !== undefined ? { stub_version: args.stubVersion } : {}),
      ...(args.checkpoint !== undefined ? { checkpoint: args.checkpoint } : {}),
      content_hashes: args.contentHashes,
      body_hashes: args.bodyHashes,
      pdf_hashes: args.pdfHashes,
    },
  };
  await new ChainEventLog(storage).append(event);
  return event;
}

// ─── Delete (tombstoned) ─────────────────────────────────────────────────────

export interface DeleteOptions {
  /** Closed reason code (§6.3.1). `ctx delete` defaults to `user_request`. */
  reasonCode: ForgetReasonCode;
  /** Actor performing the delete; recorded on the event. */
  deletedBy: string;
  requestedBy?: string;
  /**
   * Remove the node and leave NO tombstone record: its path and content may
   * be published again, and nothing refuses a pre-delete copy. The explicit
   * escape hatch (`ctx delete --purge`) for re-creating a node under the same
   * name — not for erasure.
   */
  purge?: boolean;
}

export interface DeleteResult {
  id: string;
  title: string;
  /** False only for a purge. */
  tombstoned: boolean;
  event: HashChainEvent | null;
}

/**
 * Delete a node — file, history, pdf sidecar — and, unless `purge` is set,
 * leave a tombstone record so the deletion cannot be silently undone (§6.3.4):
 * a later publish at that path, or an import of a pre-delete copy under any
 * path, is refused exactly as for a forgotten node. The record carries the
 * deleted versions' hashes only; their content goes with the files.
 *
 * Unlike `forgetDocument` this removes the node's history, so the chain
 * evidence of its versions survives only in the record and in the checkpoints
 * that sealed them. Use forget when the audit trail must keep verifying.
 */
export async function deleteDocumentWithTombstone(
  storage: NestStorage,
  docId: string,
  options: DeleteOptions,
): Promise<DeleteResult> {
  assertSafeDocumentId(docId);
  const node = await storage.readDocument(docId);
  const title = node.frontmatter.title;
  if (options.purge || isForgotten(node)) {
    // A forgotten stub's forget is already on record; deleting the stub adds
    // nothing a second record would say.
    await storage.deleteDocument(docId);
    return { id: docId, title, tombstoned: !options.purge, event: null };
  }
  assertReason(options.reasonCode);

  const history = await storage.readHistory(docId).catch(() => null);
  const entries = (history?.versions ?? []).filter((e) => !e.tombstone);
  const { bodyHashes, pdfHashes } = await collectErasedHashes(storage, node, entries);

  await storage.deleteDocument(docId);
  const event = await record(storage, {
    docId,
    mode: "delete",
    versions: entries.map((e) => e.version),
    at: new Date().toISOString(),
    actor: options.deletedBy,
    reasonCode: options.reasonCode,
    requestedBy: options.requestedBy,
    ...(entries.length > 0 ? { resultingHash: entries[entries.length - 1].chain_hash } : {}),
    contentHashes: entries.map((e) => e.content_hash),
    bodyHashes,
    pdfHashes,
  });
  return { id: docId, title, tombstoned: true, event };
}

// ─── Audit trail ─────────────────────────────────────────────────────────────

/**
 * The forget audit trail (`ctx forget-log`): every recorded forget and
 * tombstoned delete, oldest first, optionally for one document. Carries who /
 * when / which reason code / which versions — never any forgotten content.
 */
export async function forgetLog(
  storage: NestStorage,
  docId?: string,
): Promise<TombstoneRecord[]> {
  const index = await storage.readTombstones();
  return docId ? (index.byDocument.get(docId) ?? []) : index.records;
}

// ─── Anti-resurrection ───────────────────────────────────────────────────────

/**
 * Refuse a write that would put forgotten content back (§6.3.4): a forgotten
 * stub, a path a forget or tombstoned delete retired (even after the stub was
 * deleted and the file re-created), or a body whose checksum matches erased
 * content anywhere in the vault. A forgotten path is never un-forgotten;
 * content genuinely meant to exist again is published under a new path — a
 * new identity with its own chain.
 *
 * `index` lets a batch read the registry once.
 */
export async function assertNotForgotten(
  storage: NestStorage,
  node: ContextNode,
  index?: TombstoneIndex,
): Promise<void> {
  if (isForgotten(node)) throw new ForgottenDocumentError(node.id);
  const tombstones = index ?? (await storage.readTombstones());
  if (tombstones.records.length === 0) return;
  if (isPathForgotten(tombstones, node.id)) {
    throw new ForgottenDocumentError(
      node.id,
      "was forgotten or deleted — its path cannot take content again; publish under a new path",
    );
  }
  const body = forgettableBodyHash(node.rawContent || serializeDocument(node));
  if (body && tombstones.bodyHashes.has(body)) {
    throw new ForgottenDocumentError(node.id, "carries the content of a forgotten node");
  }
}

/**
 * Honor forgets that arrived with an import (§6.3.4 "exports carry
 * tombstones"): record each incoming forget event this vault has not seen, and
 * re-apply it to any local copy the vault already holds — a pre-forget copy
 * here MUST NOT outlive a forget made elsewhere. Returns the ids brought in line.
 */
export async function applyImportedTombstones(
  storage: NestStorage,
  incomingEvents: readonly unknown[],
  index: TombstoneIndex,
): Promise<string[]> {
  const log = new ChainEventLog(storage);
  const known = new Set((await log.readAll()).map((e) => e.event_id));
  const applied: string[] = [];
  for (const raw of incomingEvents) {
    const rec = tombstoneFromEvent(raw);
    if (!rec) continue;
    if (!known.has(rec.event_id)) {
      try {
        await log.append(raw as HashChainEvent);
      } catch {
        // Not a schema-valid event: honor it for this import, but do not
        // write a malformed record into this vault's audit log.
      }
      known.add(rec.event_id);
    }
    addTombstone(index, rec);

    let node: ContextNode;
    try {
      node = await storage.readDocument(rec.document_id);
    } catch {
      continue; // Nothing held locally under that path.
    }
    const history = await storage.readHistory(rec.document_id).catch(() => null);
    try {
      if (rec.mode === "delete") {
        // Deleted where the export came from: delete the local copy too.
        await storage.deleteDocument(rec.document_id);
      } else if (isForgotten(node)) {
        // The stub is here already; make sure nothing erased lingers.
        for (const e of history?.versions ?? []) {
          if (e.tombstone) await storage.removeVersionArtifacts(rec.document_id, e.version);
        }
        continue;
      } else {
        await forgetNode(storage, node, history, {
          reasonCode: rec.reason_code,
          forgottenBy: rec.forgotten_by,
          replay: rec,
        });
      }
      applied.push(rec.document_id);
    } catch (err) {
      throw new ContextNestError(
        `Could not apply the imported forget of ${rec.document_id}: ${err instanceof Error ? err.message : String(err)}`,
        "FORGOTTEN_DOCUMENT",
        "§6.3.4",
      );
    }
  }
  return applied;
}
