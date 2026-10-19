/**
 * Passage windows for reranking.
 *
 * Cross-encoder rerankers judge a (query, passage) pair, so feeding them a
 * whole 3–4k-token document dilutes a relevant paragraph deep in the text.
 * Bedrock KB reranks ~300-token chunks; we do the same at query time:
 * split each candidate into ~300-token windows (paragraph-aware, small
 * overlap), rerank the windows, and score each document by its best window.
 */

/** ~300 tokens at ~4 chars/token. */
export const DEFAULT_PASSAGE_CHARS = 1200;
/** Carried from the end of one window into the next (~40 tokens). */
export const DEFAULT_PASSAGE_OVERLAP = 150;

/**
 * Split text into windows of at most `windowChars` characters. Paragraphs
 * (blank-line separated) are packed whole where they fit; a paragraph longer
 * than a window is cut on sentence boundaries where possible, else hard.
 * Each window after the first starts with the last `overlap` characters of
 * the previous one, so a fact spanning a boundary is seen whole once.
 */
export function splitPassages(
  text: string,
  windowChars = DEFAULT_PASSAGE_CHARS,
  overlap = DEFAULT_PASSAGE_OVERLAP,
): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= windowChars) return [clean];
  const ov = Math.min(overlap, Math.floor(windowChars / 4));

  // 1. Units no longer than a window: paragraphs, long ones cut by sentence.
  const units: string[] = [];
  for (const para of clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= windowChars) {
      units.push(para);
      continue;
    }
    let buf = "";
    for (const sentence of para.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [para]) {
      if (buf && buf.length + sentence.length > windowChars) {
        units.push(buf.trim());
        buf = "";
      }
      if (sentence.length > windowChars) {
        for (let i = 0; i < sentence.length; i += windowChars) units.push(sentence.slice(i, i + windowChars));
        continue;
      }
      buf += sentence;
    }
    if (buf.trim()) units.push(buf.trim());
  }

  // 2. Pack units into windows, carrying a tail of the previous window.
  const windows: string[] = [];
  let cur = "";
  for (const u of units) {
    const joined = cur ? `${cur}\n\n${u}` : u;
    if (joined.length <= windowChars) {
      cur = joined;
      continue;
    }
    if (cur) windows.push(cur);
    const tail = cur ? cur.slice(-ov).replace(/^\S*\s/, "") : "";
    cur = tail && tail.length + 2 + u.length <= windowChars ? `${tail}\n\n${u}` : u;
  }
  if (cur) windows.push(cur);
  return windows;
}
