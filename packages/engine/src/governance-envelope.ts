/**
 * Governance envelope — SCAFFOLD for `ctx query --strict --actor`
 * (ctx-forget-strict-pr-spec §2).
 *
 * `--strict` is the "governed retrieval" mode: instead of returning raw
 * candidates, it returns a sealed envelope of {records, directive, provenance}
 * that a downstream LLM is meant to treat as a closed world — answer ONLY from
 * the records, refuse anything outside them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TODO(ctx-forget-strict-pr-spec §2): THIS IS A SCAFFOLD, NOT THE REAL MODEL.
 *
 * The per-record PRINCIPAL ELIGIBILITY model — owner / assignment / consent /
 * delegation, evaluated per (actor, record) — is NOT implemented here. The
 * current scaffold does ONLY:
 *   1. tombstone exclusion (reused from Feature 1 — `isTombstoned`), and
 *   2. zone-level RBAC via the EXISTING injected `RbacHook` (the CLI ships a
 *      permissive hook, so in the CLI today every zone passes).
 *
 * The real eligibility index must be PORTED from the Python reference at:
 *   /home/misha/Development/contextnest/eval/_gatemem/bench/agents/rag_policy.py
 * which is a STRUCTURAL, no-LLM policy index (owner/assignment/consent/
 * delegation lookups — deterministic, not model-judged). Do NOT invent a
 * principal schema here; port the reference's structure faithfully. Until then
 * `eligibility_reason` is always "zone-rbac+not-tombstoned" and MUST NOT be
 * read as a real per-principal authorization decision.
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { ContextNode, RbacHook } from "./types.js";
import { NestStorage } from "./storage.js";
import { GraphQueryEngine } from "./graph-query-engine.js";

/** Fixed instruction prepended to the envelope for the downstream LLM. */
export const STRICT_ENVELOPE_DIRECTIVE =
  "Use ONLY these records; refuse anything outside; never summarize restricted content.";

/** One record in a governance envelope. */
export interface EnvelopeRecord {
  id: string;
  title: string;
  body: string;
}

/** Per-record provenance entry — why the record is eligible for this actor. */
export interface EnvelopeProvenance {
  id: string;
  version?: number;
  /**
   * SCAFFOLD value only — currently a fixed structural reason, NOT a real
   * per-principal eligibility decision (see file-level TODO).
   */
  eligibility_reason: string;
}

export interface GovernanceEnvelope {
  records: EnvelopeRecord[];
  directive: string;
  provenance: EnvelopeProvenance[];
}

export interface GovernanceEnvelopeOptions {
  /** Graph traversal depth (default: 2). */
  hops?: number;
  /** Force full-load mode (default: false). */
  full?: boolean;
  /**
   * Zone-RBAC hook. The engine stays identity-agnostic — the caller supplies
   * the policy. The CLI ships a permissive hook for the scaffold.
   */
  rbac?: RbacHook;
}

/**
 * Compute a strict governance envelope for `selector` as seen by `actor`.
 *
 * SCAFFOLD: records = normal retrieval candidates (tombstoned already excluded
 * by `GraphQueryEngine` per Feature 1) filtered through zone-level RBAC only.
 * See the file-level TODO — per-principal eligibility is not yet implemented.
 */
export async function computeGovernanceEnvelope(
  storage: NestStorage,
  selector: string,
  actor: string,
  options: GovernanceEnvelopeOptions = {},
): Promise<GovernanceEnvelope> {
  const engine = new GraphQueryEngine(storage);
  const result = await engine.query(selector, {
    hops: options.hops ?? 2,
    full: options.full ?? false,
    // Strict mode never surfaces drafts.
    includeDrafts: false,
  });

  // Retrieval candidates already exclude tombstoned nodes (Feature 1). Source
  // nodes participate in the same closed world.
  const candidates: ContextNode[] = [...result.documents, ...result.sourceNodes];

  const records: EnvelopeRecord[] = [];
  const provenance: EnvelopeProvenance[] = [];

  for (const doc of candidates) {
    // Zone-level RBAC. With no zone or no hook, default-allow (the engine is
    // identity-agnostic; the bridge supplies the real policy). A zone present
    // with a hook that denies ingest elides the record entirely.
    const zone = doc.frontmatter.zone;
    if (zone && options.rbac) {
      const allowed = await options.rbac.canIngest(actor, zone);
      if (!allowed) continue;
    }

    records.push({
      id: doc.id,
      title: doc.frontmatter.title,
      body: doc.body,
    });
    provenance.push({
      id: doc.id,
      version: doc.frontmatter.version,
      // SCAFFOLD ONLY — see file-level TODO. Not a per-principal decision.
      eligibility_reason: "zone-rbac+not-tombstoned",
    });
  }

  return {
    records,
    directive: STRICT_ENVELOPE_DIRECTIVE,
    provenance,
  };
}
