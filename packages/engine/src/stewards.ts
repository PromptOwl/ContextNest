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
 *
 * NOTE: this union lists the CANONICAL roles, not a runtime guarantee. Because
 * this module is format-only (validating role names is the consumer's
 * enforcement job), `parseStewards` preserves any non-empty role string as
 * authored — so a `StewardEntry.role` read back from a parsed file may hold a
 * value outside this union. Consumers that switch/pattern-match on `role` must
 * handle the non-canonical case rather than assume exhaustiveness.
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

/** Coerce a raw YAML list into StewardEntry[] (drops only rows without an email). */
function toEntries(raw: unknown): StewardEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StewardEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const email = typeof obj.email === "string" ? obj.email.trim() : "";
    if (!email) continue;
    const entry: StewardEntry = { email };
    // Keep any role string as authored. This module is format-only; validating
    // role names is enforcement (the consumer's job), and silently dropping a
    // non-canonical role here would be a quiet permissions regression.
    if (typeof obj.role === "string" && obj.role.trim()) {
      entry.role = obj.role.trim() as StewardRole;
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
  try {
    const loaded = yamlLoad(content);
    if (loaded && typeof loaded === "object") doc = loaded as Record<string, unknown>;
  } catch {
    // Malformed or legacy-shorthand YAML — e.g. the comma-joined single-line
    // entries the previous hand-rolled community parser tolerated
    // (`- email: a@b.com, role: admin`), which js-yaml rejects with a throw.
    // Fall back to a lenient line parse so consumers neither get an unhandled
    // exception (→ 500 on stewards sync) nor a silently dropped role.
    return parseLenient(content);
  }

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
 * Clean a keyed steward group for serialization, dropping keys whose entry list
 * is empty. Mirrors `toGroup` on the parse side so the roundtrip is symmetric:
 * `parseStewards` never yields an empty-array group, so `serializeStewards` must
 * not emit one either (otherwise `{ tags: { "#x": [] } }` would serialize to a
 * group that parses back to nothing — a silent asymmetry).
 */
function cleanGroup(
  group: Record<string, StewardEntry[]>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, entries] of Object.entries(group)) {
    if (entries.length) out[key] = entries.map(cleanEntry);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Serialize a StewardsConfig to canonical `stewards.yaml`.
 * Roundtrip-safe: parseStewards(serializeStewards(cfg)) is equivalent to cfg
 * (empty groups AND empty-entry-list keys omitted, entries reduced to email +
 * optional role).
 */
export function serializeStewards(config: StewardsConfig): string {
  const doc: Record<string, unknown> = { version: config.version ?? 1 };
  if (config.nest?.length) doc.nest = config.nest.map(cleanEntry);
  if (config.tags) {
    const tags = cleanGroup(config.tags);
    if (tags) doc.tags = tags;
  }
  if (config.documents) {
    const documents = cleanGroup(config.documents);
    if (documents) doc.documents = documents;
  }
  return yamlDump(doc, { lineWidth: -1, quotingType: '"', forceQuotes: false });
}

/**
 * Lenient line-based fallback for input that strict YAML rejects — notably the
 * legacy comma-joined single-line entry (`- email: a@b.com, role: admin, ...`)
 * the previous hand-rolled community parser tolerated. Never throws; extracts
 * email + role per entry regardless of layout. Only used when yamlLoad fails.
 */
function parseLenient(content: string): StewardsConfig {
  const result: StewardsConfig = { version: 1 };
  let section: "nest" | "tags" | "documents" | null = null;
  let target: string | null = null;
  let entries: StewardEntry[] = [];

  const flush = () => {
    if (!section || entries.length === 0) return;
    if (section === "nest") result.nest = [...(result.nest || []), ...entries];
    else if (section === "tags" && target) (result.tags ||= {})[target] = entries;
    else if (section === "documents" && target) (result.documents ||= {})[target] = entries;
    entries = [];
  };

  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    // Only a '#' at column 0 is a comment. An INDENTED '#tag:' is a tag-key
    // header (tag scopes are '#'-prefixed), so it must not be skipped here.
    if (!line || line.startsWith("#")) continue;

    // Top-level inline `version: N`. It has no trailing ':' so the section-header
    // branch below never catches it; without this the lenient path would silently
    // pin every legacy file to version 1 (matching the role handling — no field
    // gets dropped just because strict YAML rejected the file's shorthand).
    const ver = line.match(/^version:\s*(\d+)/);
    if (ver) { result.version = Number(ver[1]); continue; }

    // Top-level section header (no indent, ends with ':')
    if (!/^\s/.test(line) && line.endsWith(":")) {
      flush();
      target = null;
      const key = line.slice(0, -1).trim();
      if (key === "version") { section = null; continue; }
      section = key === "nest" || key === "data_room" ? "nest"
        : key === "tags" ? "tags"
        : key === "documents" ? "documents"
        : null; // folders (legacy) + anything else ignored
      continue;
    }
    // Sub-target header (indented, ends with ':') under tags/documents.
    // Accept ANY leading whitespace, not just 2 spaces / a tab — legacy files
    // that reach this fallback are exactly the irregular ones (4-space nesting,
    // mixed indent), and matching a fixed width silently dropped their entries.
    // A list entry ("- ...") ends in a value not a colon, so it won't match here.
    const sub = line.match(/^\s+(\S.*):$/);
    if (sub && section && section !== "nest") {
      flush();
      target = sub[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    // List entry
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && section) {
      const entry = parseLenientEntry(item[1].trim());
      if (entry) entries.push(entry);
    }
  }
  flush();
  return result;
}

/** Pull email + optional role out of one entry line, layout-agnostic. */
function parseLenientEntry(str: string): StewardEntry | null {
  const email = str.match(/email:\s*["']?([^\s,"'{}]+)["']?/)?.[1];
  if (!email) return null;
  const entry: StewardEntry = { email };
  const role = str.match(/role:\s*["']?([A-Za-z_]+)["']?/)?.[1];
  if (role) entry.role = role as StewardRole;
  return entry;
}
