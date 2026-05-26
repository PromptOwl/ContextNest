/**
 * Suggestion staging — bridge-function-spec Story 3.1, hootie-inbox-spec §4.
 *
 * When the engine detects an out-of-band edit (or receives a remote-pushed
 * delta, or quarantines a revoked-user's offline edits), it captures the
 * change as a patch + meta record under `_suggestions/`. The canonical
 * document on disk and in the hash chain are **never** touched by this
 * module — they only change when an approval action commits a new version.
 *
 * Per spec:
 *   - Story 3.1: "ContextNest intercepts the change and routes it into the
 *     `_suggestions/` subfolder as a patch file instead of altering the
 *     canonical string. The canonical document remains untouched."
 *   - Hootie §4.2: "Until owner acts, document remains at last approved
 *     state for injection purposes. The proposed change is staged — it
 *     does not affect the live hash chain state."
 *   - Story 1.3: Revoked-user offline pushes are routed here with
 *     `source: "quarantine"` for Czar review.
 */

import { createPatch } from "diff";
import { computeContentHash } from "./integrity.js";
import { getChecksumContent } from "./parser.js";
import { suggestionMetaSchema } from "./schemas.js";
import type { NestStorage } from "./storage.js";
import type {
  GovernanceTier,
  SuggestionMeta,
  SuggestionSource,
} from "./types.js";

/** Input to `stageSuggestion`. */
export interface StageSuggestionInput {
  storage: NestStorage;
  /** e.g. `"nodes/sales-playbook"` (no `.md` suffix). */
  documentId: string;
  /** Last-approved canonical bytes (typically the latest keyframe). */
  approvedRawContent: string;
  /** Bytes the user / remote wants to commit (live drifted file, push payload). */
  proposedRawContent: string;
  /** What surfaced this drift (Story 3.1 / Story 1.3 / etc.). */
  source: SuggestionSource;
  /** Opaque actor string (bridge supplies — engine never interprets). */
  actor: string;
  zone?: string;
  docTier: GovernanceTier;
  note?: string;
  /** ISO-8601 timestamp. Defaults to `new Date().toISOString()`. */
  detectedAt?: string;
  /**
   * Optional override for the suggestion ID. Tests use this for
   * determinism; production callers should let the function generate one.
   */
  suggestionId?: string;
}

/** Result of staging a suggestion. */
export interface StageSuggestionResult {
  meta: SuggestionMeta;
  /** Absolute path to the written patch file. */
  patchPath: string;
  /** Absolute path to the written meta YAML file. */
  metaPath: string;
}

/**
 * Stage a proposed change as a patch + meta record under `_suggestions/`.
 *
 * Does NOT modify the canonical document or the hash chain. Idempotency is
 * filesystem-level: each call generates a unique suggestion ID (timestamp +
 * proposed-hash prefix), so re-staging the same drift on a different call
 * produces a separate record — by design, since detection time is part of
 * the audit trail.
 */
export async function stageSuggestion(
  input: StageSuggestionInput,
): Promise<StageSuggestionResult> {
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  const targetHash = computeContentHash(getChecksumContent(input.approvedRawContent));
  const proposedHash = computeContentHash(getChecksumContent(input.proposedRawContent));

  const suggestionId =
    input.suggestionId ?? generateSuggestionId(detectedAt, proposedHash);

  const patch = createPatch(
    input.documentId,
    input.approvedRawContent,
    input.proposedRawContent,
    "approved",
    "proposed",
  );

  const patchPath = await input.storage.writeSuggestionPatch(
    input.documentId,
    suggestionId,
    patch,
  );

  // patch_path stored in meta is the file basename relative to the
  // suggestion directory — keeps the meta portable across roots.
  const meta: SuggestionMeta = {
    suggestion_id: suggestionId,
    document_id: input.documentId,
    zone: input.zone,
    doc_tier: input.docTier,
    source: input.source,
    actor: input.actor,
    detected_at: detectedAt,
    target_hash: targetHash,
    proposed_hash: proposedHash,
    patch_path: `${suggestionId}.patch`,
    note: input.note,
  };

  // Validate before write so we never persist a malformed audit record.
  const validated = suggestionMetaSchema.parse(meta);

  const metaPath = await input.storage.writeSuggestionMeta(
    input.documentId,
    suggestionId,
    validated,
  );

  return { meta: validated as SuggestionMeta, patchPath, metaPath };
}

/** Convenience wrapper that stages with `source: "quarantine"` (Story 1.3). */
export async function quarantineSuggestion(
  input: Omit<StageSuggestionInput, "source">,
): Promise<StageSuggestionResult> {
  return stageSuggestion({ ...input, source: "quarantine" });
}

/** List all staged suggestion metas for a document, sorted by suggestion ID. */
export async function listSuggestions(
  storage: NestStorage,
  documentId: string,
): Promise<SuggestionMeta[]> {
  const ids = await storage.listSuggestionIds(documentId);
  const metas: SuggestionMeta[] = [];
  for (const id of ids) {
    const raw = await storage.readSuggestionMeta(documentId, id);
    if (!raw) continue;
    const result = suggestionMetaSchema.safeParse(raw);
    if (result.success) {
      metas.push(result.data as SuggestionMeta);
    }
  }
  return metas;
}

/**
 * Read a single suggestion's meta + patch, or null when not found.
 * Returns the patch separately because the meta does not embed bytes.
 */
export async function readSuggestion(
  storage: NestStorage,
  documentId: string,
  suggestionId: string,
): Promise<{ meta: SuggestionMeta; patch: string } | null> {
  const rawMeta = await storage.readSuggestionMeta(documentId, suggestionId);
  if (!rawMeta) return null;
  const metaResult = suggestionMetaSchema.safeParse(rawMeta);
  if (!metaResult.success) return null;
  const patch = await storage.readSuggestionPatch(documentId, suggestionId);
  if (patch === null) return null;
  return { meta: metaResult.data as SuggestionMeta, patch };
}

function generateSuggestionId(detectedAt: string, proposedHash: string): string {
  // proposedHash format: "sha256:<64-hex>". Take first 8 hex chars after the
  // prefix for the shortHash component.
  const shortHash = proposedHash.replace(/^sha256:/, "").slice(0, 8);
  const tsSafe = detectedAt.replace(/[:.]/g, "-");
  return `s_${tsSafe}_${shortHash}`;
}
