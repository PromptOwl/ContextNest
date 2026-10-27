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
 * JSON, keeping Dates: YAML frontmatter can hold a timestamp (`title:
 * 2024-01-01`), which plain JSON would hand back as a string, and the index
 * would print it differently from a crawl.
 */
export function serializeManifest(manifest: Manifest): string {
  // Where each Date sat, beside the entry — never a marker inside the value,
  // which authored frontmatter could spell too (`description: {$date: x}`).
  const documents: Record<string, ManifestEntry & { dates?: string[][] }> = {};
  for (const [id, entry] of Object.entries(manifest.documents)) {
    const dates: string[][] = [];
    findDates(entry.frontmatter, [], dates);
    documents[id] = dates.length ? { ...entry, dates } : entry;
  }
  return JSON.stringify({ ...manifest, documents });
}

export function parseManifest(text: string): Manifest | null {
  // Not a JSON.parse reviver: it runs for every value, links included, and
  // made the read several times slower.
  const manifest = JSON.parse(text) as { documents?: Record<string, ManifestEntry & { dates?: string[][] }> } | null;
  for (const entry of Object.values(manifest?.documents ?? {})) {
    for (const path of entry.dates ?? []) {
      const parent = path.slice(0, -1).reduce<any>((at, key) => at?.[key], entry.frontmatter);
      if (parent && typeof parent[path.at(-1)!] === "string") parent[path.at(-1)!] = new Date(parent[path.at(-1)!]);
    }
    delete entry.dates;
  }
  return manifest as Manifest | null;
}

function findDates(value: unknown, path: string[], out: string[][]): void {
  if (value instanceof Date) out.push(path);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) findDates(child, [...path, key], out);
  }
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
