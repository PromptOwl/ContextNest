/**
 * Resolving a document id to the casing it has ON DISK (issue #117).
 *
 * On a case-insensitive filesystem (macOS, Windows) a read of `nodes/report.md`
 * succeeds against a file named `nodes/Report.md`, and the reader gets the id
 * back exactly as it passed it. Discovery, though, reports the node by the name
 * the directory listing gives it — `nodes/Report`. Anything derived from the
 * caller's spelling (a pdf node's `pdf.file`, its `<id>.pdf` sidecar, its
 * `.versions/` history) then disagrees with the id every other surface uses.
 *
 * This walks the id one segment at a time and swaps each segment for the entry
 * its parent directory actually lists. It is only meaningful for an id the
 * caller has just found on disk: on a case-sensitive filesystem that id's exact
 * spelling is always listed, so nothing changes there.
 *
 * Kept free of `node:fs` so it can be unit-tested on Linux with a fake,
 * case-insensitive `readdir`.
 */

/** Lists the entry names of a vault-relative directory (`""` is the vault root). */
export type ListDirectory = (relDir: string) => Promise<string[]>;

/**
 * The entry in `names` that `wanted` refers to: the exact spelling when it is
 * listed, otherwise the single entry equal to it ignoring case. Null when there
 * is none, or when several entries differ from it only by case — a directory
 * that holds both `Report.md` and `REPORT.md` is case-sensitive, so the
 * caller's spelling (which matched neither) names neither of them.
 */
function matchEntry(names: readonly string[], wanted: string): string | null {
  if (names.includes(wanted)) return wanted;
  const folded = wanted.toLowerCase();
  const candidates = names.filter((n) => n.toLowerCase() === folded);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * `id` with every segment spelled the way its directory lists it. `suffix` is
 * the extension of the file the id names (`.md` for a document), matched along
 * with the last segment.
 *
 * Never throws for a path it cannot resolve: a segment with no unambiguous
 * match — or a directory that cannot be listed — leaves that segment and
 * everything after it as the caller spelled them, which is exactly what the
 * caller would have used without this.
 */
export async function resolveIdCasing(
  id: string,
  listDirectory: ListDirectory,
  suffix = ".md",
): Promise<string> {
  const segments = id.split("/");
  const resolved: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const wanted = last ? `${segments[i]}${suffix}` : segments[i];
    let names: string[];
    try {
      names = await listDirectory(resolved.join("/"));
    } catch {
      return [...resolved, ...segments.slice(i)].join("/");
    }
    const match = matchEntry(names, wanted);
    if (match === null) return [...resolved, ...segments.slice(i)].join("/");
    resolved.push(last ? match.slice(0, match.length - suffix.length) : match);
  }
  return resolved.join("/");
}
