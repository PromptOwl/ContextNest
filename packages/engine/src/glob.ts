/**
 * Minimal glob over the vault tree.
 *
 * Replaces fast-glob (18 transitive packages) with the small subset the engine
 * actually uses: `*` and `**` over posix-style relative paths. There is no
 * brace expansion, no `?`, no character classes, and no extglob — if a pattern
 * here ever needs them, that is the signal to reach for a real glob library
 * again rather than to grow this one.
 *
 * Dot handling follows fast-glob's default (`dot: false`): a wildcard never
 * matches a leading `.`, but a literal dotted segment in the pattern (e.g.
 * `**​/.versions/*​/history.yaml`) matches exactly as written. That makes the
 * `dot` option unnecessary at every call site.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Escape the regex metacharacters that can appear in a literal path segment. */
function escapeLiteral(part: string): string {
  return part.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

/** Compile a glob into a RegExp matched against a full relative posix path. */
function globToRegExp(pattern: string, dot: boolean): RegExp {
  const notDot = dot ? "" : "(?!\\.)";
  const source = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      // `**/` spans zero or more directories.
      if (part === "**/") return `(?:${notDot}[^/]+/)*`;
      // A trailing `**` is only used by ignore patterns, which should be greedy.
      if (part === "**") return ".*";
      if (part === "*") return `${notDot}[^/]*`;
      return escapeLiteral(part);
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/**
 * Collect every file under `root` as a relative posix path.
 *
 * Unreadable directories are skipped rather than thrown from — the vault crawl
 * must survive a single permission-denied subdirectory (this is what
 * fast-glob's `suppressErrors` bought us).
 */
async function walkFiles(
  root: string,
  base: string,
  maxDepth = Infinity,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Never a knowledge node, and descending is pure cost.
        if (entry.name === "node_modules") continue;
        // Files inside this directory sit at depth + 2; if no pattern can
        // match that deep, reading it is pure cost too.
        if (depth + 1 < maxDepth) await walk(join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }

  const baseDepth = base ? base.split("/").length : 0;
  await walk(base ? join(root, base) : root, base, baseDepth);
  return files;
}

/**
 * How many path segments the deepest match can have, or Infinity when any
 * pattern contains `**` and so spans arbitrarily many directories.
 *
 * A pattern without `**` matches a fixed number of segments, so the walk can
 * stop descending instead of reading a subtree it must then throw away —
 * which is what makes a single-folder listing cheap rather than merely
 * narrow. Exported for tests: like sharedBase, the pruning is observable
 * only in how much of the tree was read.
 */
export function maxMatchDepth(patterns: string[]): number {
  let deepest = 0;
  for (const pattern of patterns) {
    if (pattern.includes("**")) return Infinity;
    deepest = Math.max(deepest, pattern.split("/").length);
  }
  return deepest;
}

/**
 * The leading directory segments of a pattern that contain no wildcard.
 *
 * `packs/**​/*.yml` can only match inside `packs/`, so there is no reason to
 * read the rest of the vault. A final segment is never counted — it is the
 * filename, not a directory to descend into.
 */
function staticBase(pattern: string): string[] {
  const segments = pattern.split("/");
  const base: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (segment.includes("*")) break;
    base.push(segment);
  }
  return base;
}

/**
 * The deepest directory that could contain a match for every pattern. Patterns
 * rooted in different places (or starting with a wildcard) fall back to `""`,
 * which walks the whole tree — the same work fast-glob would have done.
 *
 * Exported for tests: the narrowing it performs is not observable in the
 * returned paths, only in how much of the tree was read to produce them.
 */
export function sharedBase(patterns: string[]): string {
  const bases = patterns.map(staticBase);
  let shared = bases[0] ?? [];
  for (const base of bases.slice(1)) {
    let i = 0;
    while (i < shared.length && i < base.length && shared[i] === base[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.join("/");
}

/**
 * Find files under `cwd` matching any of `patterns` and none of `ignore`.
 * Returns relative posix paths; callers that care about order should sort.
 */
export async function globFiles(
  cwd: string,
  patterns: string | string[],
  ignore: string[] = [],
  dot = false,
): Promise<string[]> {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const include = list.map((p) => globToRegExp(p, dot));
  // Ignores always see dotted paths, so an exclusion cannot be dodged by one.
  const exclude = ignore.map((p) => globToRegExp(p, true));

  // Descend only into the subtree the patterns can match, and no deeper than
  // they can reach. Paths still come back relative to `cwd`, so patterns and
  // ignores are unaffected by the narrowing.
  const files = await walkFiles(cwd, sharedBase(list), maxMatchDepth(list));
  return files.filter(
    (file) =>
      include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file)),
  );
}
