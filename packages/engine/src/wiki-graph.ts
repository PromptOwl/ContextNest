/**
 * Wiki-link seed resolution + ungated graph traversal.
 *
 * The engine's selector grammar has no `[[Title]]` lexeme, so consumers
 * (the community server's query-routes) hand-rolled `[[Title]]` resolution and
 * a hop-BFS over the wikilink graph. These pure primitives move that PLUMBING
 * into the engine. Seam #3 of the engine↔community separation.
 *
 * SCOPE — deliberately UNGATED. Traversal returns the full neighborhood with
 * no draft/status/permission filtering. The eligibility GATE (which drafts a
 * caller may see, stewardship scope) is the commercial governed-retrieval
 * method and stays with the consumer: it filters BEFORE seeding and/or AFTER
 * traversal. These functions never load documents or read status — they operate
 * on whatever the consumer already loaded, so orchestration + gating stay out
 * of the engine.
 *
 * DRAFT: pure functions only. A storage-coupled convenience wrapper
 * (resolve+load+traverse in one call) can be added later if a consumer wants
 * it — left out here so loading and gating stay explicitly on the consumer.
 *
 * NOT the same as `GraphTraverser` (graph-traverser.ts). That does
 * priority-weighted BFS over the STRUCTURED, typed relationship edges declared
 * in `context.yaml`. This traverses the UNTYPED free-text link graph scraped
 * from document bodies — `[[Title]]` wikilinks and `contextnest://` links alike. Different edge source, different cost model —
 * kept separate on purpose; neither supersedes the other.
 */

import { codeMask, stripInlineCode } from "./markdown-mask.js";

// Inline link `[text](contextnest://…)` or autolink `<contextnest://…>`.
// Reference definitions are deliberately not matched — they were not links
// in the AST either.
//
// Only ONE `\s*` before the destination: two of them separated by an optional
// `<` would leave the split between them ambiguous and backtrack quadratically
// over a long run of spaces (CodeQL js/polynomial-redos). Markdown does not
// allow whitespace between `<` and the destination anyway.
//
// The link text excludes `[` as well as `]` and is length-bounded, for the same
// reason the rule-4 check in parser.ts is bounded: otherwise a line of many `[`
// with no closing bracket rescans to the end from every one of them. Unescaped
// `[` is not valid inline link text, so nothing real is lost.
//
// Lives here rather than in `inline.ts` (which re-exports it) so the link graph
// below can follow `contextnest://` links without an import cycle.
const CONTEXT_LINK =
  /\[[^\][]{0,2048}\]\(\s*<?(contextnest:\/\/[^\s)>]+)|<(contextnest:\/\/[^\s>]+)>/g;

/** Extract all contextnest:// link targets from a markdown body */
export function extractContextLinks(body: string): string[] {
  // Split on CRLF as well as LF: `.` does not match `\r` in a JS regex, so a
  // stray carriage return would defeat every end-anchored pattern below.
  const lines = body.split(/\r?\n/);
  const mask = codeMask(lines);
  const links: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = stripInlineCode(lines[i]);
    CONTEXT_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CONTEXT_LINK.exec(line)) !== null) {
      links.push(match[1] ?? match[2]);
    }
  }

  return links;
}

/**
 * The target path of a `contextnest://` link, with the anchor (`#section`),
 * checkpoint pin (`@N`) and any trailing slash stripped:
 * `contextnest://nodes/foo@3#bar` → `nodes/foo`. The pin and anchor address a
 * version / section OF the target, so the graph edge is to the node itself —
 * the same edge a `[[nodes/foo]]` wikilink produces.
 *
 * A cross-namespace link (an authority component, i.e. a remaining `://`) is
 * returned as the full original URI: it names a node in another nest, not a
 * local id. Plain index scans, no regex — linear on any input.
 */
export function contextLinkTarget(uri: string): string {
  let target = uri.startsWith("contextnest://") ? uri.slice("contextnest://".length) : uri;
  const anchorIdx = target.indexOf("#");
  if (anchorIdx !== -1) target = target.slice(0, anchorIdx);
  const pinIdx = target.indexOf("@");
  if (pinIdx !== -1) target = target.slice(0, pinIdx);
  if (target.endsWith("/")) target = target.slice(0, -1);
  return target.includes("://") ? uri : target;
}

/** Minimal doc shape these primitives need — id + title + body. */
export interface WikiDocLike {
  id: string;
  frontmatter: { title?: string };
  body: string;
}

/**
 * Extract wiki-link targets from a markdown body.
 * Handles `[[Target]]` and `[[Target|alias]]` (alias dropped). Targets are
 * trimmed and de-duplicated; a target may be a title ("Onboarding") or a node
 * id ("nodes/onboarding"). Fenced code blocks and inline code spans are
 * skipped, matching `extractContextLinks`: a `[[..]]` quoted as an example is
 * not a link.
 */
export function extractWikiLinks(body: string): string[] {
  const out = new Set<string>();
  // Inner class excludes '[' as well as ']' so it can't backtrack across
  // overlapping '[[' — keeps this linear and avoids the polynomial-ReDoS
  // pattern CodeQL flags for `[^\]]+?` on uncontrolled document bodies.
  const re = /\[\[([^[\]]+)\]\]/g;
  const lines = body.split(/\r?\n/);
  const mask = codeMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = stripInlineCode(lines[i]);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const target = m[1].split("|")[0].trim();
      if (target) out.add(target);
    }
  }
  return [...out];
}

/** Title → id lookup (exact + case-insensitive fallback) plus the id set. */
export interface WikiTitleIndex {
  /** exact frontmatter title → id */
  byTitle: Map<string, string>;
  /** lowercased title → id (case-insensitive fallback) */
  byTitleLower: Map<string, string>;
  /** known node ids */
  ids: Set<string>;
}

export function buildWikiTitleIndex(docs: WikiDocLike[]): WikiTitleIndex {
  const byTitle = new Map<string, string>();
  const byTitleLower = new Map<string, string>();
  const ids = new Set<string>();
  for (const doc of docs) {
    ids.add(doc.id);
    const title = doc.frontmatter?.title;
    if (typeof title === "string" && title.trim()) {
      // First writer wins on collision — deterministic given input order.
      if (!byTitle.has(title)) byTitle.set(title, doc.id);
      const lower = title.toLowerCase();
      if (!byTitleLower.has(lower)) byTitleLower.set(lower, doc.id);
    }
  }
  return { byTitle, byTitleLower, ids };
}

/**
 * Resolve one wiki target (id or title, optionally wrapped in `[[ ]]`, with an
 * optional `#anchor` suffix) to a node id, or null when nothing matches.
 * Shared by seed resolution here and by index-time edge extraction in
 * `inline.ts` so a `[[..]]` resolves identically in both places.
 */
export function resolveWikiTarget(target: string, index: WikiTitleIndex): string | null {
  let t = target.trim();
  // A `contextnest://` URI seed resolves by id only — it is an address, never
  // a title — so a dangling URI is null rather than a title-lookup accident.
  if (t.startsWith("contextnest://")) return resolveContextLink(t, index);
  const wrapped = t.match(/^\[\[([^[\]]+)\]\]$/);
  if (wrapped) t = wrapped[1].split("|")[0].trim();
  if (!t) return null;
  // The whole string first: `#` is legal in a title (`C#`, `Fix #123`), so it
  // is only an anchor if nothing matches as written. Stripping first would
  // make `[[C#]]` resolve to a doc titled `C` — a wrong edge, not a missing one.
  const whole = lookup(t, index);
  if (whole !== null) return whole;
  // `[[Title#section]]` — the anchor addresses a section of the target doc;
  // the edge is to the doc. Try the longest prefix first (strip at the LAST
  // `#`, then earlier ones) so `[[C# Guide#setup]]` reaches `C# Guide` rather
  // than `C`. A bare `[[#section]]` is a self-anchor: no target.
  for (let hash = t.lastIndexOf("#"); hash > 0; hash = t.lastIndexOf("#", hash - 1)) {
    const stripped = t.slice(0, hash).trim();
    if (!stripped) break;
    const hit = lookup(stripped, index);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Resolve a `contextnest://` link (pinned / anchored forms included) to a node
 * id in the doc set, or null when it names no known node — a dangling link, a
 * folder/tag/search URI, or a cross-namespace link.
 */
export function resolveContextLink(uri: string, index: WikiTitleIndex): string | null {
  const target = contextLinkTarget(uri.trim());
  return index.ids.has(target) ? target : null;
}

/**
 * Every node a body links to, resolved to ids: `[[wikilinks]]` AND
 * `contextnest://` links. The spec (§1.7) defines `contextnest://` as THE link
 * form and `[[..]]` as the wiki convenience, so a link graph that only follows
 * one of them silently drops edges. Dangling targets are omitted; order is
 * first-seen, de-duplicated. Code spans and fences are skipped for both forms.
 */
export function extractLinkedIds(body: string, index: WikiTitleIndex): string[] {
  const out = new Set<string>();
  for (const target of extractWikiLinks(body)) {
    const to = resolveWikiTarget(target, index);
    if (to) out.add(to);
  }
  for (const uri of extractContextLinks(body)) {
    const to = resolveContextLink(uri, index);
    if (to) out.add(to);
  }
  return [...out];
}

/** One exact lookup: id, then exact title, then case-insensitive title. */
function lookup(t: string, index: WikiTitleIndex): string | null {
  // Precedence: id match wins over title match. A string that is BOTH a node id
  // and some other doc's title resolves to the id. Intentional — ids are exact
  // and unambiguous; titles are user-authored free text and can collide.
  if (index.ids.has(t)) return t; // it's already an id
  return index.byTitle.get(t) ?? index.byTitleLower.get(t.toLowerCase()) ?? null;
}

/**
 * Resolve `[[Title]]` / `[[nodes/id]]` / bare title|id seeds to node ids.
 * Unresolvable seeds (dangling links) are dropped. Result is de-duplicated.
 */
export function resolveWikiSeeds(seeds: string[], index: WikiTitleIndex): string[] {
  const out = new Set<string>();
  for (const seed of seeds) {
    const id = resolveWikiTarget(seed, index);
    if (id) out.add(id);
  }
  return [...out];
}

export interface WikiTraversalResult {
  /** Reached node ids, including the seeds. */
  nodeIds: string[];
  /** Deepest hop level actually reached. */
  hopsUsed: number;
}

/**
 * Breadth-first traversal over the (undirected) body-link graph from seed ids.
 * Edges run both directions: A→B if A's body links [[B]] or
 * `[text](contextnest://B)` (pinned `@N` / `#anchor` forms included), and the
 * reverse. Both link forms produce the same edge — see `extractLinkedIds`.
 * UNGATED — every reachable node within `hops` is returned regardless of
 * status; the consumer is responsible for gating before/after.
 *
 * Expects ALREADY-RESOLVED node ids (run titles/`[[..]]` seeds through
 * `resolveWikiSeeds` first). Any seed not present in the doc set is silently
 * dropped — pass a raw title here and it contributes nothing, yielding empty or
 * partial results with no error. `hopsUsed` is the DEEPEST hop actually reached,
 * which saturates below `hops` once the frontier empties (e.g. hops:5 over a
 * 1-hop graph returns hopsUsed:1), not the requested hop count.
 *
 * Title collisions: the adjacency is built from every doc's outgoing links, so a
 * doc that LOSES a title collision (see buildWikiTitleIndex "first writer wins")
 * is still reachable via its OWN outgoing `[[..]]` links — only its role as a
 * link *target* is lost. Self-links (`[[Self]]`) are dropped (no self-edge).
 */
export function traverseWikiGraph(
  seedIds: string[],
  docs: WikiDocLike[],
  opts: { hops: number },
): WikiTraversalResult {
  const index = buildWikiTitleIndex(docs);
  // Build undirected adjacency from resolved wiki links.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const doc of docs) {
    for (const to of extractLinkedIds(doc.body, index)) link(doc.id, to);
  }

  const hops = Math.max(0, opts.hops | 0);
  const visited = new Set<string>();
  let frontier: string[] = [];
  for (const s of seedIds) {
    if (index.ids.has(s) && !visited.has(s)) {
      visited.add(s);
      frontier.push(s);
    }
  }

  let hopsUsed = 0;
  for (let depth = 0; depth < hops && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nbr of adj.get(id) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          next.push(nbr);
        }
      }
    }
    if (next.length) hopsUsed = depth + 1;
    frontier = next;
  }

  return { nodeIds: [...visited], hopsUsed };
}
