/**
 * Forget-protocol tombstone registry (§6.3.4 anti-resurrection).
 *
 * A forget leaves two kinds of record behind. Per document, the tombstoned
 * entries in `history.yaml` (hashes kept, content erased). Per vault, a
 * `document.forgotten` event in `.versions/chain_events.yaml` carrying WHICH
 * content was erased — as hashes only: the chained `content_hash` of every
 * erased version, the body checksum of every erased revision, and the sha256
 * of every erased PDF binary. A tombstoned `ctx delete` records the same.
 *
 * The vault-level record is what anti-resurrection runs on. It survives
 * `ctx delete` of the stub, travels with the vault when it is copied or
 * exported (the log lives in the vault), and is keyed by content rather than
 * by path — so a pre-forget copy imported under a new name is refused just the
 * same. This module is pure (no filesystem): storage reads the log, the forget
 * operation writes it, and the import / publish / verify paths ask it.
 */

import yaml from "js-yaml";
import { documentHistorySchema, FORGET_REASON_CODES } from "./schemas.js";
import { computeContentHash } from "./integrity.js";
import { getChecksumContent, parseDocument } from "./parser.js";
import type { ForgetReasonCode } from "./types.js";

/** The chain-event type every forget records. */
export const FORGET_EVENT_TYPE = "document.forgotten" as const;

/**
 * Bodies shorter than this (trimmed) are never recorded as forgotten content.
 * A body-hash match refuses a publish or an import anywhere in the vault; for
 * a body of a few characters ("TODO", an empty note) that would refuse
 * unrelated documents that merely say the same trivial thing.
 */
export const MIN_FORGETTABLE_BODY_LENGTH = 16;

/** One forget, as recorded in the chain-event log. Hashes only, never content. */
export interface TombstoneRecord {
  event_id: string;
  document_id: string;
  /** `node`: the whole node. (`versions`, a range, is reserved for §6.3.2
   *  range forget — not produced yet, but read so its hashes still count.) */
  scope: "node" | "versions";
  /**
   * `forget` (the default): content erased, hashes kept in the node's
   * history. `delete`: the node was removed outright (`ctx delete`), and this
   * record is all that is left — enough to refuse its resurrection.
   */
  mode: "forget" | "delete";
  /** Every version number erased by this forget. */
  versions: number[];
  reason_code: ForgetReasonCode;
  forgotten_by: string;
  forgotten_at: string;
  requested_by?: string;
  /** Forget mode: the version the empty stub was sealed as. */
  stub_version?: number;
  /** Forget mode: the checkpoint the forget cut. */
  checkpoint?: number;
  /** Chained `content_hash` of every erased version (keyframe or diff). */
  content_hashes: string[];
  /** Body checksum of every erased revision (live body included, node scope). */
  body_hashes: string[];
  /** sha256 of every erased PDF binary. */
  pdf_hashes: string[];
}

/** Every forget in a vault, indexed for the anti-resurrection checks. */
export interface TombstoneIndex {
  records: TombstoneRecord[];
  byDocument: Map<string, TombstoneRecord[]>;
  contentHashes: Set<string>;
  bodyHashes: Set<string>;
  pdfHashes: Set<string>;
}

const REASONS = new Set<string>(FORGET_REASON_CODES);

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Read a forget record back out of a raw chain event. Returns null for any
 * event that is not a well-formed forget — the log also carries every other
 * governance event, and a malformed entry must not take the index down.
 */
export function tombstoneFromEvent(raw: unknown): TombstoneRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.event_type !== FORGET_EVENT_TYPE) return null;
  if (typeof e.document_id !== "string" || typeof e.event_id !== "string") return null;
  const m = (e.action_metadata ?? {}) as Record<string, unknown>;
  const scope = m.scope === "versions" ? "versions" : m.scope === "node" ? "node" : null;
  if (!scope) return null;
  const reason = typeof m.reason_code === "string" && REASONS.has(m.reason_code)
    ? (m.reason_code as ForgetReasonCode)
    : null;
  if (!reason) return null;
  const versions = Array.isArray(m.versions)
    ? m.versions.filter((v): v is number => Number.isInteger(v))
    : [];
  return {
    event_id: e.event_id,
    document_id: e.document_id,
    scope,
    mode: m.mode === "delete" ? "delete" : "forget",
    versions,
    reason_code: reason,
    forgotten_by: typeof e.actor === "string" ? e.actor : "unknown",
    forgotten_at:
      typeof m.forgotten_at === "string"
        ? m.forgotten_at
        : typeof e.timestamp === "string"
          ? e.timestamp
          : "",
    ...(typeof m.requested_by === "string" ? { requested_by: m.requested_by } : {}),
    ...(Number.isInteger(m.stub_version) ? { stub_version: m.stub_version as number } : {}),
    ...(Number.isInteger(m.checkpoint) ? { checkpoint: m.checkpoint as number } : {}),
    content_hashes: stringArray(m.content_hashes),
    body_hashes: stringArray(m.body_hashes),
    pdf_hashes: stringArray(m.pdf_hashes),
  };
}

/** Build the index from raw chain events (any order, any other event types). */
export function buildTombstoneIndex(events: readonly unknown[]): TombstoneIndex {
  const index: TombstoneIndex = {
    records: [],
    byDocument: new Map(),
    contentHashes: new Set(),
    bodyHashes: new Set(),
    pdfHashes: new Set(),
  };
  for (const raw of events) {
    const rec = tombstoneFromEvent(raw);
    if (rec) addTombstone(index, rec);
  }
  return index;
}

/** Fold one record into an index (used when an import brings new tombstones). */
export function addTombstone(index: TombstoneIndex, rec: TombstoneRecord): void {
  if (index.records.some((r) => r.event_id === rec.event_id)) return;
  index.records.push(rec);
  const list = index.byDocument.get(rec.document_id) ?? [];
  list.push(rec);
  index.byDocument.set(rec.document_id, list);
  for (const h of rec.content_hashes) index.contentHashes.add(h);
  for (const h of rec.body_hashes) index.bodyHashes.add(h);
  for (const h of rec.pdf_hashes) index.pdfHashes.add(h);
}

/** True when a node-level forget retired this path. */
export function isPathForgotten(index: TombstoneIndex, docId: string): boolean {
  return (index.byDocument.get(docId) ?? []).some((r) => r.scope === "node");
}

/**
 * Body checksum of a raw document, in the same form as `frontmatter.checksum`
 * (the anti-resurrection key for live files), or null when the body is too
 * short to be recorded — see {@link MIN_FORGETTABLE_BODY_LENGTH}.
 */
export function forgettableBodyHash(raw: string): string | null {
  const body = getChecksumContent(raw);
  if (body.trim().length < MIN_FORGETTABLE_BODY_LENGTH) return null;
  return computeContentHash(body);
}

/**
 * Anti-resurrection check for ONE file an import is about to write at
 * `relPath` (vault-relative). Returns the reason to refuse, or null to let it
 * land. Matching is by content hash wherever there is content to hash, so a
 * pre-forget copy is refused under any path it arrives at:
 *
 *   - `.versions/<doc>/v{N}.md|diff` whose bytes hash to an erased version;
 *   - `.versions/<doc>/<sha>.pdf` naming an erased binary;
 *   - `history.yaml` with a NON-tombstoned entry whose content_hash was
 *     erased (a pre-forget history — it would un-forget those versions);
 *   - a live `.md` at a path a node-level forget retired (unless it is itself
 *     a forgotten stub), or whose body matches an erased revision.
 *
 * Unparseable files are let through: they carry nothing this check can match,
 * and `ctx validate` / `ctx verify` report them.
 */
export function importVerdict(
  index: TombstoneIndex,
  relPath: string,
  content: string,
): string | null {
  if (index.records.length === 0) return null;
  const path = relPath.replace(/\\/g, "/");

  const versioned = /^(?:(.*)\/)?\.versions\/([^/]+)\/([^/]+)$/.exec(path);
  if (versioned) {
    const docId = versioned[1] ? `${versioned[1]}/${versioned[2]}` : versioned[2];
    const file = versioned[3];
    if (/^v\d+\.(md|diff)$/.test(file)) {
      const hash = computeContentHash(content);
      if (index.contentHashes.has(hash)) {
        return `${path} restores content a forget erased (${hash})`;
      }
      return null;
    }
    if (/^[a-f0-9]{64}\.pdf$/.test(file)) {
      return index.pdfHashes.has(`sha256:${file.slice(0, 64)}`)
        ? `${path} restores a PDF binary a forget erased`
        : null;
    }
    if (file === "history.yaml") {
      let raw: unknown;
      try {
        raw = yaml.load(content);
      } catch {
        return null;
      }
      const parsed = documentHistorySchema.safeParse(raw);
      if (!parsed.success) return null;
      for (const entry of parsed.data.versions) {
        if (entry.tombstone) continue;
        if (index.contentHashes.has(entry.content_hash)) {
          return `${path} restores version ${entry.version} of ${docId}, which was forgotten`;
        }
      }
      return null;
    }
    return null;
  }

  if (/\.md$/i.test(path)) {
    const id = path.replace(/\.md$/i, "");
    let status: string | undefined;
    let body = "";
    try {
      const node = parseDocument(`${id}.md`, content, id);
      status = node.frontmatter.status;
      body = node.body;
    } catch {
      return null;
    }
    // A forgotten stub carries no content — importing one propagates the
    // forget. One that does carry a body is not a stub, whatever it says.
    if (status === "forgotten") {
      return body.trim() === "" ? null : `${id} claims status forgotten but carries a body`;
    }
    if (isPathForgotten(index, id)) {
      return `${id} was forgotten; its path cannot take content again (publish under a new path)`;
    }
    const bodyHash = forgettableBodyHash(content);
    if (bodyHash && index.bodyHashes.has(bodyHash)) {
      return `${id} carries the content of a forgotten node`;
    }
  }
  return null;
}
