/**
 * stewards.yaml — parse/serialize the portable stewardship config.
 *
 * The `stewards.yaml` format is defined in the ContextNest spec (Apache-2.0).
 * This is the canonical marshalling for it, so the community server and TheOwl
 * consume ONE implementation instead of each porting their own (there were
 * three copies). Seam #1 of the engine↔community separation.
 *
 * SCOPE: this owns the FORMAT only (parse/serialize). Stewardship ENFORCEMENT —
 * scope resolution (document > tag > nest > owner), access decisions, the
 * approval workflow — is the consumer's concern and deliberately lives OUTSIDE
 * the engine. Filesystem loading (which path, which vault) also stays with the
 * consumer; the engine only offers the canonical filename list.
 */
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

/**
 * viewer → access only · editor → edit · reviewer → approve + reject + access.
 * `role` is the sole authority signal; legacy `can_approve`/`can_reject` keys
 * are accepted on input but ignored.
 */
export type StewardRole = "editor" | "reviewer" | "viewer";

export interface StewardEntry {
  email: string;
  role?: StewardRole;
}

export interface StewardsConfig {
  version: number;
  /** Nest-wide stewards. */
  nest?: StewardEntry[];
  /** Per-tag stewards, keyed by tag (e.g. "#policy"). */
  tags?: Record<string, StewardEntry[]>;
  /** Per-document stewards, keyed by node id. */
  documents?: Record<string, StewardEntry[]>;
}

/** Canonical locations a consumer may look for the file, in precedence order. */
export const STEWARDS_FILENAMES = [
  "stewards.yaml",
  "stewards.yml",
  ".context/stewards.yaml",
] as const;

const ROLES: readonly string[] = ["editor", "reviewer", "viewer"];

/** Coerce a raw YAML list into validated StewardEntry[] (drops invalid rows). */
function toEntries(raw: unknown): StewardEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StewardEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const email = typeof obj.email === "string" ? obj.email.trim() : "";
    if (!email) continue;
    const entry: StewardEntry = { email };
    if (typeof obj.role === "string" && ROLES.includes(obj.role)) {
      entry.role = obj.role as StewardRole;
    }
    out.push(entry);
  }
  return out;
}

function toGroup(raw: unknown): Record<string, StewardEntry[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const group: Record<string, StewardEntry[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entries = toEntries(value);
    if (entries.length) group[key] = entries;
  }
  return Object.keys(group).length ? group : undefined;
}

/**
 * Parse a `stewards.yaml` string into a StewardsConfig.
 *
 * Tolerant by design: unknown top-level keys are ignored, empty groups are
 * dropped, `data_room` is accepted as a legacy alias for `nest`, and the
 * legacy `folders` section is ignored (folder scope was removed). Returns
 * `{ version: 1 }` for empty/invalid input rather than throwing.
 */
export function parseStewards(content: string): StewardsConfig {
  let doc: Record<string, unknown> = {};
  const loaded = yamlLoad(content);
  if (loaded && typeof loaded === "object") doc = loaded as Record<string, unknown>;

  const result: StewardsConfig = {
    version: typeof doc.version === "number" ? doc.version : 1,
  };

  const nest = toEntries(doc.nest ?? doc.data_room);
  if (nest.length) result.nest = nest;

  const tags = toGroup(doc.tags);
  if (tags) result.tags = tags;

  const documents = toGroup(doc.documents);
  if (documents) result.documents = documents;

  return result;
}

function cleanEntry(e: StewardEntry): Record<string, unknown> {
  return e.role ? { email: e.email, role: e.role } : { email: e.email };
}

/**
 * Serialize a StewardsConfig to canonical `stewards.yaml`.
 * Roundtrip-safe: parseStewards(serializeStewards(cfg)) is equivalent to cfg
 * (empty groups omitted, entries reduced to email + optional role).
 */
export function serializeStewards(config: StewardsConfig): string {
  const doc: Record<string, unknown> = { version: config.version ?? 1 };
  if (config.nest?.length) doc.nest = config.nest.map(cleanEntry);
  if (config.tags && Object.keys(config.tags).length) {
    doc.tags = Object.fromEntries(
      Object.entries(config.tags).map(([k, v]) => [k, v.map(cleanEntry)]),
    );
  }
  if (config.documents && Object.keys(config.documents).length) {
    doc.documents = Object.fromEntries(
      Object.entries(config.documents).map(([k, v]) => [k, v.map(cleanEntry)]),
    );
  }
  return yamlDump(doc, { lineWidth: -1, quotingType: '"', forceQuotes: false });
}
