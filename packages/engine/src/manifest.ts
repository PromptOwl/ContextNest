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

export const MANIFEST_DIR = ".context/manifest";
/** JSON, not YAML: nobody reads it but the engine, and it is parsed on every write. */
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_FORMAT = 1;

/** The frontmatter fields context.yaml and the checkpoint read. */
export type ManifestFrontmatter = Pick<
  Frontmatter,
  "title" | "description" | "type" | "tags" | "status" | "version" | "source" | "skill"
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

const FIELDS = ["title", "description", "type", "tags", "status", "version", "source", "skill"] as const;

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

export function parseManifest(text: string): Manifest | null {
  // Not a JSON.parse reviver: it runs for every value, links included, and
  // made the read several times slower.
  const manifest = JSON.parse(text) as { documents?: Record<string, ManifestEntry & { typed?: Typed[] }> } | null;
  // The manifest feeds the seal and every id is joined onto the vault root,
  // so a hand-made or tampered one is refused WHOLE — never trimmed — and the
  // caller crawls: only ids a crawl could have produced, only well-formed entries.
  for (const [id, entry] of Object.entries(manifest?.documents ?? {})) {
    if (!crawlableId(id) || !wellFormed(entry)) return null;
  }
  for (const entry of Object.values(manifest?.documents ?? {})) {
    for (const [path, kind, text] of entry.typed ?? []) {
      const parent = path.slice(0, -1).reduce<any>((at, key) => at?.[key], entry.frontmatter);
      if (!parent || typeof parent !== "object") continue;
      parent[path.at(-1)!] =
        kind === "date" ? new Date(text) : kind === "binary" ? new Uint8Array(Buffer.from(text, "base64")) : Number(text);
    }
    delete entry.typed;
  }
  return manifest as Manifest | null;
}

/**
 * An id the crawl could list: relative, "/"-separated, no empty, `.`, `..` or
 * dot-led segment (the crawl never enters one), no machinery segment, no
 * backslash or control character. Looser than the id rules for a NEW
 * document on purpose — a file already on disk may carry any other name.
 */
function crawlableId(id: string): boolean {
  if (!id || id.includes("\\") || /[\u0000-\u001f\u007f]/.test(id) || /^[a-zA-Z]:/.test(id)) return false;
  return id
    .split("/")
    .every((seg) => seg !== "" && !seg.startsWith(".") && seg !== "node_modules" && seg !== "_suggestions");
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
    e.links.wiki.every((l) => typeof l === "string")
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
    for (const [key, child] of Object.entries(value)) copy[key] = jsonSafe(child, [...path, key], out);
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
