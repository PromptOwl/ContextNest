/**
 * Vault manifest — what each document contributes to the index, so a write
 * can rebuild context.yaml and seal a checkpoint without crawling the vault.
 *
 * Listing a vault's files is most of what a write used to cost (it grows with
 * the vault, and on a network mount every file is a round trip). The manifest
 * holds, per document, the frontmatter the index and the checkpoint read and
 * the raw link targets in its body. Links are kept unresolved because a
 * `[[Title]]` resolves against every document's title: a new document can turn
 * another's dangling link into an edge, so edges are re-resolved over the
 * whole manifest each time, in memory, exactly as a crawl would.
 *
 * It is a cache: derived, rebuildable, never committed (its directory ignores
 * itself). `checkpoint` and `index_generated_at` record the state it was
 * written against; a reader that finds either moved on falls back to a crawl.
 */

import type { ContextNode, Frontmatter } from "./types.js";
import { extractContextLinks, extractWikiLinks } from "./wiki-graph.js";

/**
 * POC switch: the manifest is OFF unless `CONTEXTNEST_MANIFEST` is on
 * (`on`/`1`/`true`/`yes`). Off, the engine behaves as before it existed —
 * every write crawls, no manifest or pending file is written, `verify`
 * reports no `stale_index` — so it can ship, and be switched on per host to
 * measure, without changing anything for anyone else.
 */
export function manifestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.CONTEXTNEST_MANIFEST ?? "").trim());
}

export const MANIFEST_DIR = ".context/manifest";
/** JSON, not YAML: nobody reads it but the engine, and it is parsed on every write. */
export const MANIFEST_FILE = "manifest.json";
/**
 * Largest manifest read (an untrusted file, parsed whole). ~300 bytes an entry,
 * so this is far beyond any real vault; a bigger file is not read — the
 * caller crawls, which is always correct.
 */
export const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
export const MANIFEST_FORMAT = 1;

/** The frontmatter fields context.yaml, the checkpoint and INDEX.md read. */
export type ManifestFrontmatter = Pick<
  Frontmatter,
  "title" | "description" | "type" | "tags" | "status" | "version" | "source" | "skill" | "updated_at"
> & { metadata?: { edge_priority: number } };

export interface ManifestLinks {
  /** `contextnest://` targets, as extractContextLinks returns them. */
  context: string[];
  /** `[[wikilink]]` targets, as extractWikiLinks returns them. */
  wiki: string[];
}

export interface ManifestEntry {
  frontmatter: ManifestFrontmatter;
  links: ManifestLinks;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  /** Head checkpoint number when written. */
  checkpoint: number;
  /** `generated_at` of the context.yaml written alongside it. */
  index_generated_at: string;
  /**
   * The vault's layout when written (storage sets it). It decides which
   * folders the crawl lists, vault-wide: a flip (the first `nodes/` document
   * in a flat vault) makes the whole manifest stale, not one folder.
   */
  layout?: string;
  documents: Record<string, ManifestEntry>;
}

const FIELDS = ["title", "description", "type", "tags", "status", "version", "source", "skill", "updated_at"] as const;

export function manifestEntry(doc: ContextNode): ManifestEntry {
  const frontmatter: Record<string, unknown> = {};
  for (const key of FIELDS) {
    if (doc.frontmatter[key] !== undefined) frontmatter[key] = doc.frontmatter[key];
  }
  const ep = doc.frontmatter.metadata?.edge_priority;
  if (typeof ep === "number") frontmatter.metadata = { edge_priority: ep };
  return {
    frontmatter: frontmatter as ManifestFrontmatter,
    links: { context: extractContextLinks(doc.body), wiki: extractWikiLinks(doc.body) },
  };
}

export function buildManifest(
  docs: ContextNode[],
  state: { checkpoint: number; indexGeneratedAt: string },
): Manifest {
  const documents: Record<string, ManifestEntry> = {};
  for (const doc of sortLikeCrawl(docs)) documents[doc.id] = manifestEntry(doc);
  return {
    format: MANIFEST_FORMAT,
    checkpoint: state.checkpoint,
    index_generated_at: state.indexGeneratedAt,
    documents,
  };
}

/**
 * The manifest's documents as nodes for the index generator, in crawl order.
 * Bodies are empty: pass `manifestLinks` as the generator's `linksOf`.
 */
export function manifestDocuments(manifest: Manifest): ContextNode[] {
  return sortLikeCrawl(
    Object.entries(manifest.documents).map(([id, entry]) => ({
      id,
      filePath: "",
      frontmatter: entry.frontmatter as Frontmatter,
      body: "",
      rawContent: "",
    })),
  );
}

export function manifestLinks(manifest: Manifest): (doc: { id: string }) => ManifestLinks {
  return (doc) => manifest.documents[doc.id]?.links ?? { context: [], wiki: [] };
}

/**
 * A frontmatter value plain JSON cannot hold, with where it sat: a YAML
 * timestamp (`title: 2024-01-01`), `!!binary`, `.inf`/`.nan`, `-0`. JSON would
 * hand each back as something else and the index would print it differently
 * from a crawl.
 */
type Typed = [path: string[], kind: "date" | "binary" | "number", text: string];

/**
 * JSON with the values above kept beside each entry (`typed`) — never as a
 * marker inside the value, which authored frontmatter could spell too
 * (`description: {$date: x}`).
 */
export function serializeManifest(manifest: Manifest): string {
  const documents: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(manifest.documents)) {
    const typed: Typed[] = [];
    const frontmatter = jsonSafe(entry.frontmatter, [], typed);
    documents[id] = typed.length ? { ...entry, frontmatter, typed } : entry;
  }
  return JSON.stringify({ ...manifest, documents });
}

/** One entry as the manifest file holds it: equal strings, equal entries. */
export function serializeManifestEntry(entry: ManifestEntry): string {
  const typed: Typed[] = [];
  const frontmatter = jsonSafe(entry.frontmatter, [], typed);
  return JSON.stringify({ frontmatter, links: entry.links, typed });
}

export function parseManifest(text: string): Manifest | null {
  // Not a JSON.parse reviver: it runs for every value, links included, and
  // made the read several times slower.
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const manifest = parsed as { documents?: Record<string, ManifestEntry & { typed?: Typed[] }> };
  // The manifest feeds the seal and every id is joined onto the vault root,
  // so a hand-made or tampered one is refused WHOLE — never trimmed — and the
  // caller crawls: only ids a crawl could have produced, only well-formed entries.
  for (const [id, entry] of Object.entries(manifest?.documents ?? {})) {
    if (!crawlableId(id) || !wellFormed(entry)) return null;
  }
  for (const entry of Object.values(manifest?.documents ?? {})) {
    for (const [path, kind, text] of entry.typed ?? []) {
      const value =
        kind === "date" ? new Date(text) : kind === "binary" ? new Uint8Array(Buffer.from(text, "base64")) : Number(text);
      if (!restoreOwn(entry.frontmatter, path, value)) return null;
    }
    delete entry.typed;
  }
  return manifest as Manifest | null;
}

/**
 * Put `value` back where serializeManifest took it out, stepping through OWN
 * keys only: an authored `__proto__` key is the entry's own (js-yaml and
 * JSON.parse keep it so), while a path that would reach a prototype —
 * `constructor.prototype`, a `__proto__` the entry does not own — refuses
 * the manifest instead of writing global state.
 */
function restoreOwn(frontmatter: object, path: string[], value: unknown): boolean {
  let at: unknown = frontmatter;
  for (const key of path.slice(0, -1)) {
    if (!at || typeof at !== "object" || !Object.hasOwn(at, key)) return false;
    at = (at as Record<string, unknown>)[key];
  }
  const last = path.at(-1)!;
  // serializeManifest left `null` in this very place, so it is an own key.
  if (!at || typeof at !== "object" || !Object.hasOwn(at, last)) return false;
  Object.defineProperty(at, last, { value, writable: true, enumerable: true, configurable: true });
  return true;
}

const TYPED_KINDS = new Set(["date", "binary", "number"]);

function wellTyped(typed: unknown): boolean {
  return (
    typed === undefined ||
    (Array.isArray(typed) &&
      typed.every(
        (t) =>
          Array.isArray(t) &&
          t.length === 3 &&
          Array.isArray(t[0]) &&
          t[0].length > 0 &&
          t[0].every((k: unknown) => typeof k === "string") &&
          TYPED_KINDS.has(t[1]) &&
          typeof t[2] === "string",
      ))
  );
}

/**
 * An id the crawl could list: relative, "/"-separated, no empty, `.`, `..` or
 * dot-led segment (the crawl never enters one), no `node_modules` (never
 * walked), no backslash (a separator on Windows, so `a\..\..\x` would
 * escape) or control character. Looser than the id rules for a NEW document
 * on purpose — a file already on disk may carry any other name.
 */
function crawlableId(id: string): boolean {
  if (!id || id.includes("\\") || /[\u0000-\u001f\u007f]/.test(id)) return false;
  return id.split("/").every((seg) => seg !== "" && !seg.startsWith(".") && seg !== "node_modules");
}

function wellFormed(entry: unknown): boolean {
  const e = entry as Partial<ManifestEntry> | null;
  return (
    !!e &&
    typeof e === "object" &&
    !!e.frontmatter &&
    typeof e.frontmatter === "object" &&
    !Array.isArray(e.frontmatter) &&
    Array.isArray(e.links?.context) &&
    Array.isArray(e.links?.wiki) &&
    e.links.context.every((l) => typeof l === "string") &&
    e.links.wiki.every((l) => typeof l === "string") &&
    wellTyped((e as { typed?: unknown }).typed)
  );
}

/** A copy JSON round-trips exactly; what it cannot hold goes to `out` and leaves `null` in place. */
function jsonSafe(value: unknown, path: string[], out: Typed[]): unknown {
  if (value instanceof Date) {
    out.push([path, "date", Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString()]);
    return null;
  }
  if (value instanceof Uint8Array) {
    out.push([path, "binary", Buffer.from(value).toString("base64")]);
    return null;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    out.push([path, "number", Object.is(value, -0) ? "-0" : String(value)]);
    return null;
  }
  if (Array.isArray(value)) return value.map((v, i) => jsonSafe(v, [...path, String(i)], out));
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    // defineProperty, not `copy[key] =`: an authored `__proto__` key would
    // otherwise set the copy's prototype and vanish from the JSON.
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: jsonSafe(child, [...path, key], out), writable: true, enumerable: true, configurable: true });
    }
    return copy;
  }
  return value;
}

/**
 * discoverDocuments sorts file paths, not ids: `a/b-c.md` sorts before
 * `a/b.md` though `a/b` sorts before `a/b-c`. Title collisions resolve to the
 * first document in this order, so the manifest must keep it.
 */
function sortLikeCrawl<T extends { id: string }>(docs: T[]): T[] {
  return [...docs].sort((x, y) => {
    const a = `${x.id}.md`;
    const b = `${y.id}.md`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
