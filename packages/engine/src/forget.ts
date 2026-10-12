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
 * `ctx delete` goes through the same log (`deleteDocumentWithTombstone`): the
 * node is removed outright and an audit-only record says who deleted it, when
 * and why. It refuses nothing — the path and content stay reusable.
 *
 * Not implemented here (spec §6.3.2 range forget, §6.3.4 lineage flags,
 * §6.3.5 retention keys): see CONTEXT_NEST_SPEC.md §6.3 "Not yet implemented".
 */

import { isDeepStrictEqual } from "node:util";
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
import { assertErasableDocumentId, assertNotMachineryPath } from "./storage.js";
import { VersionManager } from "./versioning.js";
import { CheckpointManager } from "./checkpoint.js";
// Type only: structure-store imports this module.
import type { ReplayBudget } from "./structure-store.js";
import { ChainEventLog } from "./chain-log.js";
import { FORGET_REASON_CODES, hashChainEventSchema } from "./schemas.js";
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
  carriesForgottenBody,
  forgettableBodyHash,
  isPathForgotten,
  holdsErasedContent,
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
  /** The checkpoint the forget cut (0 on a replay — the import cuts one for the batch). */
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
  await assertErasableDocumentId(storage.root, docId);
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
  // Every forget — requested or imported (§6.3.4) — erases only a document,
  // before any history is touched.
  await assertErasableDocumentId(storage.root, docId);
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
  // A replay skips it: `applyImportedTombstones` cuts one for the whole batch.
  const checkpoint = options.replay
    ? null
    : await new CheckpointManager(storage).createCheckpointFromVault(docId);

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
        checkpoint: checkpoint?.checkpoint,
        contentHashes: erased.map((e) => e.content_hash),
        bodyHashes,
        pdfHashes,
      });

  return {
    id: docId,
    versions: erased.map((e) => e.version),
    stubVersion: sealed.version,
    checkpoint: checkpoint?.checkpoint ?? 0,
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
  /** Remove the node and leave NO audit record (`ctx delete --purge`). */
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
 * leave an audit-only record (§6.3.4): who, when, why, and the deleted
 * versions' content hashes. It refuses nothing, so the path can be re-created
 * and a renamed copy keeps verifying.
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
  await assertErasableDocumentId(storage.root, docId);
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

  // Record first, delete second: a crash in between leaves a record for a
  // node still present — never a deletion nothing accounts for.
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
    // Audit-only: no body/pdf hashes, so nothing vault-wide is refused.
    bodyHashes: [],
    pdfHashes: [],
  });
  await storage.deleteDocument(docId);
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
 * stub, a path a forget retired (even after the stub was
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
  if (carriesForgottenBody(tombstones, node.rawContent || serializeDocument(node))) {
    throw new ForgottenDocumentError(node.id, "carries the content of a forgotten node");
  }
}

/**
 * Honor forgets that arrived with an import (§6.3.4 "exports carry
 * tombstones"): a pre-forget copy here MUST NOT outlive a forget made
 * elsewhere, so a forget (never a delete) is re-applied to a local document
 * holding content it erased. A record naming a document here that holds none
 * of it is refused — it is no forget of this document, and logged it would
 * retire a live document's path — so a caller who may import cannot erase
 * what it may not forget. Every record kept is logged once, as the fields a
 * forget record carries (never the incoming event verbatim: an alias chain
 * would expand), in one write, before any forget is applied. Returns the ids
 * brought in line, and the refusals.
 */
export async function applyImportedTombstones(
  storage: NestStorage,
  incomingEvents: readonly unknown[],
  index: TombstoneIndex,
  /** The import's replay budget: rebuilding a copy's versions is charged to it. */
  budget?: ReplayBudget,
): Promise<{ applied: string[]; refused: Array<{ id: string; reason: string }> }> {
  const sealed = new Map<string, Set<string> | null>();
  const known = new Map<string, unknown>((await new ChainEventLog(storage).readAll()).map((e) => [e.event_id, e]));
  const applied: string[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  const toLog: HashChainEvent[] = [];
  const toApply: Array<{ rec: TombstoneRecord; node: ContextNode; history: DocumentHistory | null }> = [];
  for (const raw of incomingEvents) {
    const rec = tombstoneFromEvent(raw);
    if (!rec) continue;
    // A record naming no document of this vault (`../`, `.versions/…`, a
    // short-name alias of one, an id no file system holds) is neither logged
    // nor applied.
    try {
      await assertErasableDocumentId(storage.root, rec.document_id);
    } catch {
      continue;
    }
    // A record reusing the id of a logged event must be that event: the log
    // is deduplicated by id, so a different record under a known id would be
    // applied with no audit record of its own.
    const logged = known.get(rec.event_id);
    if (logged !== undefined && !isDeepStrictEqual(tombstoneFromEvent(logged), rec)) {
      refused.push({
        id: rec.document_id,
        reason: `the forget record ${rec.event_id} reuses the id of a logged event with a different record — not applied`,
      });
      continue;
    }
    // A delete record is audit-only: an import never deletes a local doc.
    let node: ContextNode | null = null;
    if (rec.mode !== "delete") node = await storage.readDocument(rec.document_id).catch(() => null);
    const history = node ? await storage.readHistory(rec.document_id).catch(() => null) : null;
    if (node && !isForgotten(node) && !holdsErasedContent(rec, node.rawContent, history)) {
      const bodies = rec.body_hashes.length > 0 ? await sealedBodies(storage, node, history, sealed, budget) : new Set<string>();
      if (bodies === null) {
        refused.push({
          id: rec.document_id,
          reason: `the forget of ${rec.document_id}: this import replays more version history than one call allows — split it into smaller calls`,
        });
        continue;
      }
      if (!rec.body_hashes.some((h) => bodies.has(h))) {
        refused.push({
          id: rec.document_id,
          reason: `the forget of ${rec.document_id} names a document here that holds none of the content it erased — not applied`,
        });
        continue;
      }
    }
    // The engine forgets whole documents (§6.3): a record scoped to versions
    // is recorded (what it erased stays refused) but never applied to a live
    // document here, and the import says so.
    const partial = rec.scope === "versions" && node !== null && !isForgotten(node);
    if (partial) {
      refused.push({
        id: rec.document_id,
        reason: `the forget record ${rec.event_id} is scoped to versions — this vault forgets whole documents, so it is recorded, not applied`,
      });
    }
    if (!known.has(rec.event_id)) {
      // Not a schema-valid event: honored for this import, but no malformed
      // record goes into this vault's audit log.
      const event = loggedForgetEvent(rec, raw);
      if (event) toLog.push(event);
      known.set(rec.event_id, event ?? raw);
    }
    addTombstone(index, rec);
    if (node && !partial) toApply.push({ rec, node, history });
  }
  await storage.appendChainEvents(toLog);

  for (const { rec, node, history } of toApply) {
    try {
      if (isForgotten(node)) {
        // The stub is here already; make sure nothing erased lingers.
        for (const e of history?.versions ?? []) {
          if (e.tombstone) await storage.removeVersionArtifacts(rec.document_id, e.version);
        }
        continue;
      }
      await forgetNode(storage, node, history, {
        reasonCode: rec.reason_code,
        forgottenBy: rec.forgotten_by,
        replay: rec,
      });
      applied.push(rec.document_id);
    } catch (err) {
      throw new ContextNestError(
        `Could not apply the imported forget of ${rec.document_id}: ${err instanceof Error ? err.message : String(err)}`,
        "FORGOTTEN_DOCUMENT",
        "§6.3.4",
      );
    }
  }
  // One checkpoint for every forget this import re-applied, not one each.
  if (applied.length > 0) {
    await new CheckpointManager(storage).createCheckpointFromVault(applied.join(","));
  }
  return { applied, refused };
}

/**
 * Body hashes of a document's sealed versions — an erased body may sit in
 * one only, the live body edited since (§6.3.4: the copy still holds it).
 * Rebuilt once per document per import and charged to the import's replay
 * budget; null once that is spent.
 *
 * ponytail: charges each rebuilt version's length once, though rebuilding a
 * version replays up to a keyframe interval of diffs; charge the replay itself
 * if imports of long-history vaults need a tighter bound.
 */
async function sealedBodies(
  storage: NestStorage,
  node: ContextNode,
  history: DocumentHistory | null,
  cache: Map<string, Set<string> | null>,
  budget: ReplayBudget | undefined,
): Promise<Set<string> | null> {
  const cached = cache.get(node.id);
  if (cached !== undefined) return cached;
  let bodies: Set<string> | null = new Set();
  const vm = new VersionManager(storage);
  for (const entry of history?.versions ?? []) {
    if (entry.tombstone) continue;
    let raw: string;
    try {
      raw = await vm.reconstructVersion(node.id, entry.version, history!);
    } catch {
      continue; // Unreconstructable: its content_hash still names it.
    }
    if (budget) {
      budget.left -= raw.length;
      if (budget.left < 0) budget.spent = true;
      if (budget.spent) {
        bodies = null;
        break;
      }
    }
    const h = forgettableBodyHash(raw);
    if (h) bodies.add(h);
  }
  cache.set(node.id, bodies);
  return bodies;
}

/**
 * The event logged for an imported forget: only what a forget record carries,
 * rebuilt from it. Null when that is not a valid event.
 */
function loggedForgetEvent(rec: TombstoneRecord, raw: unknown): HashChainEvent | null {
  const e = raw as Record<string, unknown>;
  const event = {
    event_id: rec.event_id,
    event_type: FORGET_EVENT_TYPE,
    timestamp: e.timestamp,
    actor: e.actor,
    document_id: rec.document_id,
    ...(typeof e.resulting_hash === "string" ? { resulting_hash: e.resulting_hash } : {}),
    action_metadata: {
      scope: rec.scope,
      mode: rec.mode,
      versions: rec.versions,
      reason_code: rec.reason_code,
      ...(rec.requested_by !== undefined ? { requested_by: rec.requested_by } : {}),
      ...(rec.forgotten_at ? { forgotten_at: rec.forgotten_at } : {}),
      ...(rec.stub_version !== undefined ? { stub_version: rec.stub_version } : {}),
      ...(rec.checkpoint !== undefined ? { checkpoint: rec.checkpoint } : {}),
      content_hashes: rec.content_hashes,
      body_hashes: rec.body_hashes,
      pdf_hashes: rec.pdf_hashes,
    },
  };
  const parsed = hashChainEventSchema.safeParse(event);
  return parsed.success ? (parsed.data as HashChainEvent) : null;
}
