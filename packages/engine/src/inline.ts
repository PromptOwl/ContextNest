/**
 * Inline syntax extraction from markdown bodies (§1.7).
 * Extracts contextnest:// links, #tags, @mentions, and task checkboxes.
 */

import type { ContextNode, RelationshipEdge } from "./types.js";

/**
 * Mark which lines sit inside a fenced code block, so link and heading
 * scanning skips them the way a real markdown parse would.
 */
function codeMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      mask[i] = true;
      const closes =
        marker !== null &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        lines[i].slice(marker[0].length).trim() === "";
      if (closes) fence = null;
    } else if (marker) {
      mask[i] = true;
      fence = marker[1];
    }
  }

  return mask;
}

/** Blank out inline code spans so their contents are not scanned. */
function stripInlineCode(line: string): string {
  return line.replace(/`+[^`]*`+/g, (span) => " ".repeat(span.length));
}

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

/**
 * Build a relationship edge list from all documents.
 * Extracts `reference` edges from contextnest:// links
 * and `depends_on` edges from source node frontmatter.
 */
export function buildRelationships(documents: ContextNode[]): RelationshipEdge[] {
  const edges: RelationshipEdge[] = [];

  for (const doc of documents) {
    // Extract reference edges from inline links
    const links = extractContextLinks(doc.body);
    for (const link of links) {
      // Extract path from URI, stripping anchor and checkpoint
      let target = link.replace("contextnest://", "");
      // Remove anchor
      const anchorIdx = target.indexOf("#");
      if (anchorIdx !== -1) target = target.slice(0, anchorIdx);
      // Remove checkpoint pin
      const pinIdx = target.indexOf("@");
      if (pinIdx !== -1) target = target.slice(0, pinIdx);
      // Remove trailing slash
      if (target.endsWith("/")) target = target.slice(0, -1);

      // If it looks like a cross-namespace link (contains authority), keep full URI
      const to = target.includes("://")
        ? link
        : target;

      edges.push({ from: doc.id, to, type: "reference" });
    }

    // Extract depends_on edges from source node frontmatter
    if (doc.frontmatter.source?.depends_on) {
      for (const dep of doc.frontmatter.source.depends_on) {
        const target = dep.replace("contextnest://", "");
        edges.push({ from: doc.id, to: target, type: "depends_on" });
      }
    }
  }

  return edges;
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
