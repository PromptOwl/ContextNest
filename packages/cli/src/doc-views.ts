/**
 * Shared view shapes and formatting for commands that run against BOTH a
 * local vault and a remote nest.
 *
 * The local branches (index.ts) work on engine `ContextNode`s and the remote
 * branches (remote.ts) on catalog summaries — each maps its native objects
 * into these views, then filtering, field selection, and `--json` shapes are
 * SINGLE-SOURCED here. The local/remote parity regression suite verifies the
 * mapping; this module is what makes the shared semantics impossible to
 * change in one branch without the other.
 */

import { normalizeStatus } from "@promptowl/contextnest-engine";

/** The fields `ctx list` filtering and output need, regardless of source. */
export interface DocListView {
  id: string;
  title: string;
  type?: string;
  status?: string;
  tags?: string[];
}

/**
 * `ctx list` filter semantics: type filter (default "document"), status
 * filter with alias normalization, tag filter with # auto-prefix, and the
 * default rejected-hidden rule when no status is requested.
 */
export function filterDocList<T extends DocListView>(
  docs: T[],
  opts: { type?: string; status?: string; tag?: string },
): T[] {
  let out = docs;
  if (opts.type) out = out.filter((d) => (d.type || "document") === opts.type);
  if (opts.status) {
    const wanted = normalizeStatus(opts.status);
    out = out.filter((d) => (d.status || "draft") === wanted);
  } else {
    out = out.filter((d) => d.status !== "rejected");
  }
  if (opts.tag) {
    const normalizedTag = opts.tag.startsWith("#") ? opts.tag : `#${opts.tag}`;
    out = out.filter((d) => d.tags?.includes(normalizedTag));
  }
  return out;
}

/** One entry of `ctx list --json`. */
export function listJsonEntry(d: DocListView) {
  return {
    id: d.id,
    title: d.title,
    type: d.type || "document",
    status: d.status || "draft",
    tags: d.tags,
  };
}

/** Document/source-node fields `ctx query --json` selects. */
export interface QueryDocView {
  id: string;
  title: string;
  body?: string;
  source?: unknown;
}

/** The full `ctx query --json` payload shape. */
export function queryJsonPayload(p: {
  documents: QueryDocView[];
  sourceNodes: QueryDocView[];
  traceCount: number;
  mode?: string;
  hopsUsed?: number;
  nodesTraversed?: number;
}) {
  return {
    documents: p.documents.map((d) => ({ id: d.id, title: d.title, body: d.body })),
    sourceNodes: p.sourceNodes.map((d) => ({
      id: d.id,
      title: d.title,
      source: d.source,
      body: d.body,
    })),
    traceCount: p.traceCount,
    mode: p.mode,
    hopsUsed: p.hopsUsed,
    nodesTraversed: p.nodesTraversed,
  };
}

/** One entry of `ctx search --json`. */
export function searchJsonEntry(d: { id: string; title: string; description?: string; type?: string }) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    type: d.type || "document",
  };
}

/** Derive a display title from a doc id leaf: "nodes/foo-bar" → "Foo Bar". */
export function titleFromId(id: string): string {
  return id
    .split("/")
    .pop()!
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c: string) => c.toUpperCase());
}

/** Parse a --tags option: comma/space separated, each tag #-prefixed. */
export function parseTagsOption(tags: string): string[] {
  return tags
    .split(/[,\s]+/)
    .filter((t: string) => t.length > 0)
    .map((t: string) => (t.startsWith("#") ? t : `#${t}`));
}
