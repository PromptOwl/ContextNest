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
