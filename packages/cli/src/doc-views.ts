import chalk from "chalk";

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

/** One hit of `context_search`, as the CLI renders it. */
export interface SearchHitView {
  id: string;
  title: string;
  description?: string;
  type?: string;
  /** BM25 relevance score; absent from a remote nest running an older engine. */
  score?: number;
}

/** One entry of `ctx search --json`. */
export function searchJsonEntry(d: SearchHitView) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    type: d.type || "document",
    ...(typeof d.score === "number" ? { score: d.score } : {}),
  };
}

/** `ctx search` prints this many hits unless `--limit` says otherwise. */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Turn the raw `--limit` value into the `limit` sent to `context_search`:
 * absent (or unparsable) → the default; `0` → undefined, i.e. everything.
 */
export function searchLimit(raw: number | undefined): number | undefined {
  if (raw === undefined || Number.isNaN(raw)) return DEFAULT_SEARCH_LIMIT;
  return raw > 0 ? raw : undefined;
}

/**
 * Render `context_search` output, local or remote. Hits arrive best-first;
 * when `total` says the list was cut, a footer names the remainder (on
 * stderr in `--json` mode so stdout stays a parseable array).
 */
export function printSearchResults(
  out: { results: SearchHitView[]; total?: number },
  opts: { json?: boolean },
): void {
  const { results } = out;
  const total = out.total ?? results.length;
  const more = Math.max(0, total - results.length);
  const footer = `… ${more} more — raise --limit (0 = all)`;
  if (opts.json) {
    console.log(JSON.stringify(results.map(searchJsonEntry), null, 2));
    if (more > 0) console.error(chalk.dim(footer));
    return;
  }
  if (results.length === 0) {
    console.log(chalk.yellow("No results found."));
    return;
  }
  console.log(
    chalk.bold(
      more > 0 ? `Top ${results.length} of ${total} result(s):\n` : `${results.length} result(s):\n`,
    ),
  );
  for (const doc of results) {
    console.log(`  ${chalk.cyan(doc.id)}: ${doc.title}`);
  }
  if (more > 0) console.log(chalk.dim(`\n${footer}`));
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
