/**
 * Code masking for body scanners. Link extraction (`inline.ts`,
 * `wiki-graph.ts`) must skip fenced blocks and inline code the way a real
 * markdown parse would, or a document that DOCUMENTS the link syntax becomes
 * a graph edge — and, once enough docs cite the same example, a hub.
 */

/**
 * Mark which lines sit inside a fenced code block, so link and heading
 * scanning skips them the way a real markdown parse would.
 */
export function codeMask(lines: string[]): boolean[] {
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
export function stripInlineCode(line: string): string {
  return line.replace(/`+[^`]*`+/g, (span) => " ".repeat(span.length));
}

