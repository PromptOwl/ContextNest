/**
 * Shared view shapes and formatting for commands that run against BOTH a
 * local vault and a remote nest.
 *
 * The local branches (index.ts) work on engine `ContextNode`s and the remote
 * branches (remote.ts) on catalog summaries — each maps its native objects
 * into these views, and the field selection behind every `--json` shape is
 * SINGLE-SOURCED here. Filtering is not: both branches hand their filters to
 * the nest that owns the documents. The local/remote parity regression suite
 * verifies both halves.
 */

/** The fields `ctx list` output needs, regardless of source. */
export interface DocListView {
  id: string;
  title: string;
  type?: string;
  status?: string;
  tags?: string[];
}

/**
 * NOTE: filtering deliberately does NOT live here. Both branches send their
 * filters to the nest that owns the documents (locally the engine's
 * filters.ts, remotely the same code behind context_list), because a
 * client-side copy of those rules drifts — and cannot recover documents the
 * nest already withheld. Only field selection is shared here.
 */

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
