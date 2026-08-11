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
async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
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
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }

  await walk(root, "");
  return files;
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
  const include = (Array.isArray(patterns) ? patterns : [patterns]).map((p) =>
    globToRegExp(p, dot),
  );
  // Ignores always see dotted paths, so an exclusion cannot be dodged by one.
  const exclude = ignore.map((p) => globToRegExp(p, true));

  const files = await walkFiles(cwd);
  return files.filter(
    (file) =>
      include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file)),
  );
}
