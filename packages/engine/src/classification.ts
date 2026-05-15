/**
 * Three-level classification cascade and Zone Challenge detection
 * (zone-classification-rbac-spec §2).
 *
 * Engine responsibilities:
 *   - Parse the `classification_manifest` block out of CLAUDE.md.
 *   - Resolve a document's zone + governance via the L1 → L2 → L3 cascade.
 *   - Flag Zone Challenges when frontmatter metadata contradicts the
 *     folder-implied classification (§2.4) — the document is NOT blocked;
 *     it remains injectable, and the challenge surfaces to the Czar.
 *
 * Not the engine's job:
 *   - Acting on a challenge (the Czar resolves it via the Inbox).
 *   - Running the L3 content scanner (rule-based vs. model call — spec §7
 *     open item). Caller supplies pre-computed signals.
 *   - Knowing which zone is "Enterprise" or "Public" — those are org-
 *     defined zone IDs. Caller supplies the default.
 */

import { z } from "zod";
import yaml from "js-yaml";
import {
  GOVERNANCE_TIERS,
  ZONE_ID_PATTERN,
} from "./schemas.js";
import type { Frontmatter, GovernanceTier } from "./types.js";
import { ConfigError } from "./errors.js";

/** A folder pattern entry in the classification manifest (§2.3). */
export interface FolderPattern {
  /** Folder prefix (e.g. "strategy/", "client/acme/"). Trailing slash required. */
  path: string;
  zone: string;
  governance: GovernanceTier;
}

/**
 * Parsed `classification_manifest` block from CLAUDE.md (§2.3).
 * `schema_version` enables forward compatibility — agents check the version
 * before applying rules.
 */
export interface ClassificationManifest {
  schema_version: string;
  patterns: FolderPattern[];
}

/**
 * Content signals supplied by the caller for L3 fallback classification
 * (§2.1 Level 3). The engine does not infer these — the bridge or a
 * dedicated content scanner produces them.
 */
export type ContentSignal = "pii" | "client-identifying" | "public-facing";

/** Outcome of running the cascade for a single document. */
export interface ClassificationResult {
  zone: string;
  governance: GovernanceTier;
  /** Which cascade level produced the result (§2.1). */
  level: 1 | 2 | 3;
  /**
   * True when L3 fallback was used and the result needs Czar confirmation
   * (§2.1: "Fallback classification is flagged as unconfirmed").
   */
  unconfirmed: boolean;
}

/**
 * Zone Challenge record (§2.4). Emitted when frontmatter declares a zone
 * that contradicts the folder-implied zone. The document remains
 * injectable; the Czar resolves the challenge via the Inbox.
 */
export interface ZoneChallenge {
  documentId: string;
  declaredZone: string;
  impliedZone: string;
  declaredGovernance?: GovernanceTier;
  impliedGovernance: GovernanceTier;
}

const folderPatternSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((p) => p.endsWith("/"), "Folder pattern must end with a trailing slash"),
  zone: z
    .string()
    .regex(ZONE_ID_PATTERN, "Zone ID must match ^[a-z][a-z0-9_-]*$"),
  governance: z.enum(GOVERNANCE_TIERS),
});

export const classificationManifestSchema = z.object({
  schema_version: z.string().min(1),
  patterns: z.array(folderPatternSchema),
});

/**
 * Parse a `classification_manifest` YAML object (already extracted from
 * its host file) into a validated `ClassificationManifest`. Throws
 * `ConfigError` on schema failure.
 */
export function parseClassificationManifest(
  raw: unknown,
): ClassificationManifest {
  const result = classificationManifestSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.errors[0];
    throw new ConfigError(
      `Invalid classification_manifest: ${first.message} at ${first.path.join(".") || "<root>"}`,
    );
  }
  return result.data;
}

/**
 * Locate and extract the `classification_manifest` block from a CLAUDE.md
 * file (§2.3). Returns `null` when the block is absent — callers should
 * treat that as "use folder-default cascade only".
 *
 * Supported syntaxes:
 *   1. A fenced ```yaml … ``` block containing `classification_manifest:`
 *      as a top-level key.
 *   2. A bare `classification_manifest:` YAML block not fenced.
 */
export function extractManifestFromClaudeMd(
  claudeMdContent: string,
): ClassificationManifest | null {
  const fencedYamlBlocks = [
    ...claudeMdContent.matchAll(/```ya?ml[ \t]*\r?\n([\s\S]*?)```/g),
  ].map((m) => m[1]);

  for (const block of fencedYamlBlocks) {
    if (!/^\s*classification_manifest\s*:/m.test(block)) continue;
    const parsed = tryYamlLoad(block);
    if (parsed && typeof parsed === "object" && "classification_manifest" in parsed) {
      return parseClassificationManifest(
        (parsed as Record<string, unknown>).classification_manifest,
      );
    }
  }

  // Fallback: try parsing the entire document as YAML in case the manifest
  // is unfenced (rare, but the spec example does not require fencing).
  const wholeDoc = tryYamlLoad(claudeMdContent);
  if (wholeDoc && typeof wholeDoc === "object" && "classification_manifest" in wholeDoc) {
    return parseClassificationManifest(
      (wholeDoc as Record<string, unknown>).classification_manifest,
    );
  }

  return null;
}

function tryYamlLoad(input: string): unknown {
  try {
    return yaml.load(input);
  } catch {
    return null;
  }
}

/** Input to `classifyDocument`. */
export interface ClassifyInput {
  /**
   * Document path relative to the vault root (forward slashes), e.g.
   * "client/acme/discovery.md" or "strategy/q4-plan.md". The cascade
   * matches folder patterns against this path.
   */
  documentPath: string;
  frontmatter: Frontmatter;
  manifest: ClassificationManifest;
  /**
   * Pre-computed L3 content signals supplied by the caller (§2.1 L3).
   * Engine does NOT scan content itself.
   */
  contentSignals?: ContentSignal[];
  /**
   * Map content signals to zone IDs. Caller supplies based on its zone
   * registry — engine does not assume which zone is "Enterprise" or
   * "Public". Unmapped signals fall through to `defaultZone`.
   */
  signalZoneMap?: Partial<Record<ContentSignal, string>>;
  /**
   * Default zone for the no-signal / no-match case (§2.1: "No signals →
   * Enterprise zone by default"). The caller passes the org's Enterprise
   * zone ID here.
   */
  defaultZone: string;
}

/**
 * Resolve a document's zone + governance via the L1 → L2 → L3 cascade.
 *
 * Precedence (§2.1):
 *   - L2 (frontmatter metadata) overrides L1 when set.
 *   - L1 (folder path) is the primary signal.
 *   - L3 (content signals / default) is the fallback when neither set.
 *
 * A Zone Challenge raised by `detectZoneChallenge` does NOT change the
 * resolution here — metadata still wins (§2.4: doc remains injectable).
 * The challenge is a separate audit record.
 */
export function classifyDocument(input: ClassifyInput): ClassificationResult {
  const folderMatch = matchLongestFolderPattern(
    input.documentPath,
    input.manifest.patterns,
  );

  const declaredZone = input.frontmatter.zone;
  const declaredGovernance = input.frontmatter.governance;

  // L2 — metadata override (when present)
  if (declaredZone || declaredGovernance) {
    return {
      zone: declaredZone ?? folderMatch?.zone ?? input.defaultZone,
      governance:
        declaredGovernance ??
        folderMatch?.governance ??
        ("standard" as GovernanceTier),
      level: 2,
      unconfirmed: false,
    };
  }

  // L1 — folder pattern
  if (folderMatch) {
    return {
      zone: folderMatch.zone,
      governance: folderMatch.governance,
      level: 1,
      unconfirmed: false,
    };
  }

  // L3 — content-signal fallback (§2.1)
  const signalZone = resolveSignalZone(
    input.contentSignals,
    input.signalZoneMap,
  );
  return {
    zone: signalZone ?? input.defaultZone,
    governance: "standard",
    level: 3,
    unconfirmed: true,
  };
}

function resolveSignalZone(
  signals: ContentSignal[] | undefined,
  map: Partial<Record<ContentSignal, string>> | undefined,
): string | undefined {
  if (!signals || signals.length === 0 || !map) return undefined;
  // Spec §2.1 priority order: PII → Enterprise minimum (most restrictive)
  // first; client-identifying next; public-facing last.
  const priority: ContentSignal[] = [
    "pii",
    "client-identifying",
    "public-facing",
  ];
  for (const sig of priority) {
    if (signals.includes(sig) && map[sig]) return map[sig];
  }
  return undefined;
}

function matchLongestFolderPattern(
  documentPath: string,
  patterns: readonly FolderPattern[],
): FolderPattern | null {
  let best: FolderPattern | null = null;
  for (const p of patterns) {
    if (documentPath.startsWith(p.path)) {
      if (!best || p.path.length > best.path.length) best = p;
    }
  }
  return best;
}

/** Input to `detectZoneChallenge`. */
export interface ZoneChallengeInput {
  documentId: string;
  documentPath: string;
  frontmatter: Frontmatter;
  manifest: ClassificationManifest;
}

/**
 * Emit a Zone Challenge when frontmatter declares a zone that contradicts
 * the folder-implied zone (§2.4). Returns `null` when there is no
 * contradiction (no metadata zone, or metadata zone matches folder, or no
 * folder pattern matches).
 *
 * Per spec: the document is NOT blocked. The challenge is informational
 * for the Czar to resolve via the Inbox.
 */
export function detectZoneChallenge(
  input: ZoneChallengeInput,
): ZoneChallenge | null {
  const declaredZone = input.frontmatter.zone;
  if (!declaredZone) return null;

  const folderMatch = matchLongestFolderPattern(
    input.documentPath,
    input.manifest.patterns,
  );
  if (!folderMatch) return null;
  if (folderMatch.zone === declaredZone) return null;

  return {
    documentId: input.documentId,
    declaredZone,
    impliedZone: folderMatch.zone,
    declaredGovernance: input.frontmatter.governance,
    impliedGovernance: folderMatch.governance,
  };
}
