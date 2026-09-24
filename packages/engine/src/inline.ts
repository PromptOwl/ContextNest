/**
 * Inline syntax extraction from markdown bodies (§1.7).
 * Extracts contextnest:// links, #tags, @mentions, and task checkboxes.
 */

import type { ContextNode, RelationshipEdge } from "./types.js";
import { codeMask } from "./markdown-mask.js";
import {
  buildWikiTitleIndex,
  contextLinkTarget,
  extractContextLinks,
  extractWikiLinks,
  resolveWikiTarget,
} from "./wiki-graph.js";

// `extractContextLinks` lives in wiki-graph.ts (the link graph follows these
// links too); re-exported here, its long-standing home.
export { extractContextLinks };

/** Extract all #tag references from a markdown body */
export function extractTags(body: string): string[] {
  const tags = new Set<string>();
  // Match #tag that is not inside a URL or code block
  // Simple approach: match standalone #word patterns
  const pattern = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    tags.add(`#${match[1]}`);
  }
  return [...tags];
}

/** Extract all @mention references from a markdown body */
export function extractMentions(body: string): string[] {
  const mentions = new Set<string>();
  const pattern = /(?:^|\s)@((?:team:)?[a-zA-Z][a-zA-Z0-9._-]*[a-zA-Z0-9])/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    mentions.add(`@${match[1]}`);
  }
  return [...mentions];
}

/** Count task checkboxes in a markdown body */
export function countTasks(body: string): { total: number; completed: number } {
  const incomplete = (body.match(/- \[ \]/g) || []).length;
  const complete = (body.match(/- \[x\]/gi) || []).length;
  return { total: incomplete + complete, completed: complete };
}

/** How the relationship edge list was built — surfaced by `ctx index`. */
export interface RelationshipStats {
  /** Total edges emitted (after dedupe). */
  edges: number;
  /** Edges that exist only because of a `[[wikilink]]`. */
  fromWikilinks: number;
  /** `[[wikilinks]]` whose target matched no published document. */
  unresolvedWikilinks: number;
  /**
   * Local `contextnest://` links whose target is no published document — a
   * dangling node link, or a tag / folder / search URI (those address a set,
   * not a node, so they are never an edge). Cross-namespace links are not
   * counted: they name a node in another nest and still produce an edge.
   */
  unresolvedContextLinks: number;
}

/**
 * Build a relationship edge list from all documents.
 * Extracts `reference` edges from contextnest:// links AND `[[wikilinks]]`,
 * and `depends_on` edges from source node frontmatter. Edges are de-duplicated
 * by (from, to, type); self-links are dropped.
 *
 * Wikilinks live here rather than in the index generator so that
 * `buildBacklinks` (the engine's backlinks API) and `generateContextYaml`
 * (context.yaml) can never disagree about which edges exist. `[[Title]]`, `[[title]]`,
 * `[[Title|alias]]`, `[[Title#anchor]]` and `[[nodes/id]]` all resolve
 * through the same `wiki-graph` helpers the query side uses. A target that
 * matches nothing produces no edge and is counted in `unresolvedWikilinks`.
 *
 * `contextnest://` links follow the same rule as the body-link traversal
 * (`resolveContextLink`): a local link only becomes an edge when its target
 * (pin/anchor stripped) is a published document; otherwise it is counted in
 * `unresolvedContextLinks`. So context.yaml, backlinks and `traverseWikiGraph`
 * agree on which edges exist, not only on where they point. The one
 * deliberate exception is a cross-namespace link (with an authority), which
 * names a node in another nest: it keeps its full URI as the edge target,
 * because the local index cannot say whether it resolves.
 */
export function buildRelationshipsWithStats(
  documents: ContextNode[],
): { edges: RelationshipEdge[]; stats: RelationshipStats } {
  const edges: RelationshipEdge[] = [];
  const seen = new Set<string>();
  const stats: RelationshipStats = {
    edges: 0,
    fromWikilinks: 0,
    unresolvedWikilinks: 0,
    unresolvedContextLinks: 0,
  };

  /** Push unless an identical (from, to, type) edge is already present. */
  const add = (edge: RelationshipEdge): boolean => {
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push(edge);
    return true;
  };

  const index = buildWikiTitleIndex(documents);

  for (const doc of documents) {
    // Extract reference edges from inline links
    const links = extractContextLinks(doc.body);
    for (const link of links) {
      // Path with anchor, checkpoint pin and trailing slash stripped; a
      // cross-namespace link keeps its full URI. Same helper the body-link
      // traversal in wiki-graph.ts uses, so both agree on the target.
      const to = contextLinkTarget(link);
      if (!to.includes("://")) {
        // Local: an edge only to a real node, exactly as resolveContextLink.
        if (!index.ids.has(to)) {
          stats.unresolvedContextLinks++;
          continue;
        }
        if (to === doc.id) continue;
      }
      add({ from: doc.id, to, type: "reference" });
    }

    // Extract reference edges from [[wikilinks]]
    for (const target of extractWikiLinks(doc.body)) {
      const to = resolveWikiTarget(target, index);
      if (to === null) {
        // `[[#section]]` is a self-anchor, not a dangling link.
        if (target.trim().startsWith("#")) continue;
        stats.unresolvedWikilinks++;
        continue;
      }
      if (to === doc.id) continue;
      if (add({ from: doc.id, to, type: "reference" })) stats.fromWikilinks++;
    }

    // Extract depends_on edges from source node frontmatter
    if (doc.frontmatter.source?.depends_on) {
      for (const dep of doc.frontmatter.source.depends_on) {
        const target = dep.replace("contextnest://", "");
        add({ from: doc.id, to: target, type: "depends_on" });
      }
    }
  }

  stats.edges = edges.length;
  return { edges, stats };
}

/**
 * Build a relationship edge list from all documents.
 * See `buildRelationshipsWithStats` — this is the same list without the counts.
 */
export function buildRelationships(documents: ContextNode[]): RelationshipEdge[] {
  return buildRelationshipsWithStats(documents).edges;
}

/**
 * Build a backlinks map: for each document, which other documents reference it.
 */
export function buildBacklinks(documents: ContextNode[]): Map<string, string[]> {
  const backlinks = new Map<string, string[]>();
  const edges = buildRelationships(documents);

  for (const edge of edges) {
    if (edge.type === "reference") {
      const existing = backlinks.get(edge.to) || [];
      existing.push(edge.from);
      backlinks.set(edge.to, existing);
    }
  }

  return backlinks;
}

/**
 * Extract section content by anchor from a markdown body.
 * Returns the content from the matched heading to the next heading of same or higher level.
 */
export function extractSection(body: string, anchor: string): string | null {
  // Slice from the raw lines so the returned section keeps its original line
  // endings; scan a CR-stripped copy so the patterns still anchor (see above).
  const lines = body.split("\n");
  const headings = topLevelHeadings(lines.map((l) => l.replace(/\r$/, "")));

  const start = headings.findIndex((h) => h.anchor === anchor);
  if (start === -1) return null;

  let endLine = lines.length;
  for (let i = start + 1; i < headings.length; i++) {
    if (headings[i].depth <= headings[start].depth) {
      endLine = headings[i].line;
      break;
    }
  }

  return lines.slice(headings[start].line, endLine).join("\n").trim();
}

interface Heading {
  depth: number;
  anchor: string;
  /** 0-based index of the line the heading starts on */
  line: number;
}

/**
 * Collect top-level (unindented, outside code fences) ATX and setext headings.
 * Headings nested in lists or blockquotes are skipped, matching the previous
 * behaviour of only walking the AST root's children.
 */
function topLevelHeadings(lines: string[]): Heading[] {
  const mask = codeMask(lines);
  const headings: Heading[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;

    // Deliberately does NOT capture the heading text with a trailing `(.*)$`.
    // Pairing `\s+` with `.*` leaves the boundary between them ambiguous, and
    // `.` cannot match a line terminator, so a long whitespace run followed by
    // text and a stray CR makes the engine retry every split — quadratic
    // (CodeQL js/polynomial-redos). The marker is all the match is needed for;
    // the text comes from a slice.
    // Up to 3 leading spaces are allowed on an ATX heading (CommonMark); 4 or
    // more makes it an indented code block instead.
    const atx = /^ {0,3}(#{1,6})\s/.exec(lines[i]);
    if (atx) {
      const depth = atx[1].length;
      // Drop an optional closing sequence: `## Title ##`. Trailing whitespace
      // goes first so the pattern can anchor to the end with nothing ambiguous
      // in front of it.
      const text = lines[i].slice(atx[0].length).trimEnd().replace(/#+$/, "");
      headings.push({ depth, anchor: toAnchor(text), line: i });
      continue;
    }

    const underline = lines[i + 1];
    const isSetext =
      underline !== undefined &&
      !mask[i + 1] &&
      lines[i].trim() !== "" &&
      !/^\s{0,3}[-*+>]\s/.test(lines[i]) &&
      /^\s{0,3}(=+|-+)\s*$/.test(underline);
    if (isSetext) {
      headings.push({
        depth: underline.trim()[0] === "=" ? 1 : 2,
        anchor: toAnchor(lines[i]),
        line: i,
      });
      i++;
    }
  }

  return headings;
}

/**
 * Heading text to anchor: strip inline markup, lowercase, spaces to hyphens,
 * drop anything that is not alphanumeric or a hyphen.
 */
function toAnchor(raw: string): string {
  return raw
    .replace(/`+/g, "")
    // Each span excludes its own opening delimiter as well as its closing one,
    // and both are length-bounded (CodeQL js/polynomial-redos). Two separate
    // inputs are quadratic otherwise: a run of `[`, where the text span scans
    // to end-of-line from every one of them, and a run of `[](`, where the
    // destination span does the same. Excluding `[` and `(` makes both fail on
    // the first character instead, and neither is valid unescaped in the span
    // it is excluded from.
    .replace(/!?\[([^\][]{0,2048})\]\([^()]{0,2048}\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
