/**
 * Import hygiene — what `context_import` does to a file it did not author.
 *
 * A folder import ingests whatever a user's notes tool exported: files named
 * `Untitled 1.md` or `?tab=t.vdb3f3osszzz.md`, frontmatter with no `title`,
 * `type: note`, a whole hashtag list pasted into one tag. Every one of those
 * lands as a node that `ctx validate` rejects and `ctx list` names
 * `undefined`. The engine cannot refuse the import — the notes are the whole
 * point — so it repairs the minimum needed to make each node valid and reports
 * every repair as a warning, leaving a file that is already valid untouched.
 *
 * Pure functions: the import executor decides where they apply.
 */

import { NODE_TYPES, TAG_PATTERN } from "./schemas.js";
import type { ContextNode, Frontmatter, NodeType } from "./types.js";

const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

/** Same rule as `buildDraftNode`'s slug: one dash per non-alphanumeric run. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A segment that already reads as a slug is left exactly as it is. */
const CLEAN_SEGMENT = /^[a-z0-9][a-z0-9_.-]*$/;

/** A short trailing extension (`.md`, `.yaml`, `.json`) on the last segment. */
const EXTENSION = /\.[a-z0-9]{1,8}$/i;

/**
 * Slugify a vault-relative path segment by segment so the id an imported
 * file gets is one every surface can address: `nodes/Dr. Smith.md` becomes
 * `nodes/dr-smith.md`, `nodes/?tab=t.vdb3f3osszzz.md` becomes
 * `nodes/tab-t-vdb3f3osszzz.md`. Dot-directories (`.versions`) and segments
 * that are already clean pass through unchanged, so an exported vault's own
 * layout — version histories included — survives the trip, and a directory
 * is renamed the same way as the document it belongs to.
 *
 * A dot-directory is lower-cased on the way through: every other segment
 * comes out lowercase, so leaving `.Versions` and `.versions` distinct would
 * plan two targets that are one file on Windows and macOS.
 *
 * `..` also starts with a dot and so passes through untouched. That is not an
 * oversight and this is NOT the traversal guard: `NestStorage.vaultFilePath`
 * refuses `..` outright, so such a path fails at its own write and is reported
 * as one failed file rather than being silently rewritten into something that
 * looks legitimate.
 */
export function slugifyImportPath(relPath: string): string {
  const segments = String(relPath ?? "").split(/[/\\]/).filter(Boolean);
  return segments
    .map((segment, i) => {
      if (segment.startsWith(".")) return segment.toLowerCase();
      if (CLEAN_SEGMENT.test(segment)) return segment;
      const isLast = i === segments.length - 1;
      const ext = isLast ? (segment.match(EXTENSION)?.[0] ?? "") : "";
      const stem = ext ? segment.slice(0, -ext.length) : segment;
      const slug = slugify(stem) || "untitled";
      return `${slug}${ext.toLowerCase()}`;
    })
    .join("/");
}

/** Where the last path segment's extension starts, or its length if none. */
function extensionStart(segment: string): number {
  const ext = segment.match(EXTENSION)?.[0] ?? "";
  return segment.length - ext.length;
}

/**
 * Whether a path lives inside a `.versions/` directory — a sealed version
 * artifact (`v{N}.md`, `v{N}.diff`, `history.yaml`) rather than a live document.
 *
 * A keyframe is a whole document, so `v1.md` looks exactly like a node to
 * anything that only inspects the last path segment. Its bytes are hashed into
 * the version's `content_hash` and chained, so repairing its frontmatter breaks
 * the chain: `ctx verify` then reports a version the import itself rewrote as
 * tampered. Sealed history is imported verbatim, whatever state it is in.
 */
export function isVersionArtifactPath(relPath: string): boolean {
  return String(relPath ?? "")
    .split(/[/\\]/)
    .some((segment) => segment.toLowerCase() === ".versions");
}

/**
 * Split `<dir>/.versions/<stem>/<rest>` into the pieces needed to rebuild the
 * path under a different stem.
 */
function versionPathParts(path: string): { prefix: string; suffix: string } | undefined {
  const segments = path.split("/");
  const i = segments.indexOf(".versions");
  if (i < 0 || i + 1 >= segments.length) return undefined;
  return {
    prefix: segments.slice(0, i + 1).join("/"),
    suffix: segments.slice(i + 2).join("/"),
  };
}

/**
 * The document a path belongs to, as its ORIGINAL `<dir>/<stem>`:
 * `nodes/Dr. Smith.md` and `nodes/.versions/Dr. Smith/v1.md` both key to
 * `nodes/Dr. Smith`.
 *
 * Deliberately keyed on the raw path, not the slugified one. Two different
 * source documents can collapse onto one slug (`nodes/foo.md` and
 * `nodes/Foo.md`), and only the second of them is renamed — a rename recorded
 * under the shared slug would then redirect the FIRST document's history into
 * the second's `.versions/` directory, which is the corruption this map exists
 * to prevent.
 */
function rawDocKey(rawPath: string): string {
  const segments = String(rawPath ?? "")
    .split(/[/\\]/)
    .filter(Boolean);
  const i = segments.findIndex((segment) => segment.toLowerCase() === ".versions");
  if (i >= 0 && i + 1 < segments.length) {
    return [...segments.slice(0, i), segments[i + 1]].join("/");
  }
  const last = segments.pop() ?? "";
  return [...segments, last.slice(0, extensionStart(last))].join("/");
}

/**
 * Decide where every file in a `files[]` batch lands, so that no two files
 * — and no file and one already in the vault — share an id.
 *
 * Slugifying is lossy: `Untitled (1).md`, `Untitled_1.md` and
 * `Untitled - 1.md` all become `untitled-1.md`, and every all-non-Latin name
 * becomes `untitled.md`. Written concurrently, the last one silently wins
 * and `written` counts files that are not there. So the targets for the WHOLE
 * batch are planned up front, sequentially and in input order: the first claim
 * on a slug keeps it, the next gets `-2`, then `-3`, and so on —
 * deterministic, so a re-run of the same batch lands the same way. A target
 * `isTaken` reports counts as claimed too. Every rename is warned, naming what
 * it collided with.
 *
 * A renamed document takes its version history with it. `.versions/<stem>/`
 * is addressed by the document's stem (`storage.readVersion`), so leaving the
 * history at the old stem while the document moves to `<stem>-2` either
 * strands it or files it under a DIFFERENT document that already owns that
 * directory — silent corruption of someone else's chain. Documents therefore
 * claim their targets before any version file is placed, since a batch may
 * well list `history.yaml` first.
 */
export async function planImportPaths(
  rawPaths: string[],
  isTaken: (relPath: string) => Promise<boolean>,
): Promise<Array<{ raw: string; path: string; warnings: string[] }>> {
  const claimed = new Map<string, string>(); // target → raw path that owns it
  const renamedStems = new Map<string, string>(); // `<dir>/<stem>` → new stem
  const bases = rawPaths.map((raw) => slugifyImportPath(raw));
  const plan: Array<{ raw: string; path: string; warnings: string[] }> = new Array(rawPaths.length);
  // Stable sort, so documents — and version files among themselves — keep
  // their input order and the `-2`/`-3` numbering stays deterministic.
  const order = bases
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Number(versionPathParts(bases[a]) !== undefined) -
        Number(versionPathParts(bases[b]) !== undefined),
    );

  for (const i of order) {
    const raw = rawPaths[i];
    const warnings: string[] = [];
    const parts = versionPathParts(bases[i]);
    const movedStem = parts ? renamedStems.get(rawDocKey(raw)) : undefined;
    const base =
      parts && movedStem !== undefined
        ? [parts.prefix, movedStem, parts.suffix].filter(Boolean).join("/")
        : bases[i];
    const cut = base.lastIndexOf("/") + 1;
    const dir = base.slice(0, cut);
    const last = base.slice(cut);
    const stemEnd = extensionStart(last);
    const stem = last.slice(0, stemEnd);
    const ext = last.slice(stemEnd);

    let target = base;
    let takenBy: string | undefined;
    for (let n = 2; ; n++) {
      const owner = claimed.get(target);
      if (owner !== undefined) {
        takenBy ??= owner;
      } else if (await isTaken(target)) {
        takenBy ??= "an existing vault file";
      } else {
        break;
      }
      target = `${dir}${stem}-${n}${ext}`;
    }
    claimed.set(target, raw);
    if (!parts && target !== base) {
      renamedStems.set(rawDocKey(raw), target.slice(cut, -ext.length || undefined));
    }

    if (takenBy !== undefined) {
      const reason =
        takenBy === "an existing vault file"
          ? `"${base}" already exists in the vault`
          : `"${base}" is already taken by ${takenBy}`;
      warnings.push(`${raw}: written as ${target} (${reason})`);
    } else if (movedStem !== undefined) {
      warnings.push(`${raw}: written as ${target} (follows its renamed document)`);
    } else if (target !== raw) {
      warnings.push(`${raw}: written as ${target} (path slugified)`);
    }
    plan[i] = { raw, path: target, warnings };
  }
  return plan;
}

/** A line that opens or closes a fenced code block (``` or ~~~, ≤3 spaces indent). */
function isFenceLine(line: string): boolean {
  const t = line.trimStart();
  return line.length - t.length <= 3 && (t.startsWith("```") || t.startsWith("~~~"));
}

/**
 * The first top-level `# Heading` in a markdown body, if there is one.
 *
 * A character walk rather than a regex: the body is document input, and the
 * natural pattern (`^#[ \t]+(.+?)[ \t]*#*[ \t]*$`) has overlapping
 * quantifiers that backtrack polynomially on a line of `#` followed by
 * thousands of tabs (CodeQL js/polynomial-redos).
 *
 * Lines inside a fenced code block are skipped: a shell comment in a
 * ```` ```sh ```` block is not the note's title.
 */
export function firstHeading(body: string): string | undefined {
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Up to 3 leading spaces still opens a heading, same as a fence.
    const text0 = line.trimStart();
    if (line.length - text0.length > 3) continue;
    // Exactly one `#`, then at least one space or tab: `##` is a section.
    if (text0.charCodeAt(0) !== 0x23 /* # */) continue;
    const second = text0.charAt(1);
    if (second !== " " && second !== "\t") continue;
    // Trailing closing hashes (`# Title ##`) are decoration, not title.
    let end = text0.length;
    while (end > 1 && (text0[end - 1] === " " || text0[end - 1] === "\t")) end--;
    while (end > 1 && text0[end - 1] === "#") end--;
    const text = text0.slice(1, end).trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * Split one raw tag entry into candidate tags.
 *
 * A hashtag list pasted into a single YAML entry — `gtm #contextnest
 * #promptowl` — is the common malformation, and it is recoverable: the
 * author meant three tags. A plain multi-word value with no `#` in it is not
 * a list, it is one invalid tag, and is left whole for the validator to drop.
 */
function splitTagEntry(raw: string): string[] {
  const bare = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!bare.includes("#")) return [bare];
  // Whitespace first, then `#` inside each token — two single-character
  // splits, so nothing here backtracks on a long run of tabs.
  return bare
    .split(/\s+/)
    .flatMap((token) => token.split("#"))
    .filter(Boolean);
}

/**
 * Normalize an imported tag list: split pasted hashtag lists, drop entries
 * that fail the spec tag rule, prefix with `#`, de-duplicate. Returns the
 * tags to keep and at most one warning per entry — the warning quotes the
 * whole entry, so one per bad candidate would repeat the same line.
 */
export function sanitizeImportedTags(
  raw: unknown[],
  label: string,
): { tags: string[]; warnings: string[] } {
  const tags: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    let dropped = false;
    for (const candidate of splitTagEntry(entry.trim())) {
      if (!TAG_PATTERN.test(candidate)) {
        dropped = true;
        continue;
      }
      const tag = `#${candidate}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
    if (dropped) {
      warnings.push(
        `${label}: dropped tag "${entry}" (tags must start with a letter and contain only letters, digits, _ - :)`,
      );
    }
  }
  return { tags, warnings };
}

/**
 * The frontmatter repairs an imported document needs to validate, as a
 * patch to spread over its frontmatter, plus one warning per repair the
 * author should know about.
 *
 * - No `title` → the body's first `# heading`, else `fallbackTitle` (the
 *   original filename, human casing intact — `Dr. Smith`). Not warned: every
 *   hand-authored note lacks one, and the title is derived, not invented.
 * - No `type` → `document`, silently; `type` outside the spec's node types →
 *   `document`, warned.
 * - Tags that fail the tag rule → dropped, warned; pasted hashtag lists are
 *   split first so `"#gtm #contextnest"` becomes two tags, not garbage.
 *
 * A document that already carries valid values gets an empty patch, so a
 * caller can write it back verbatim.
 */
export function sanitizeImportedFrontmatter(
  node: ContextNode,
  fallbackTitle: string,
): { patch: Partial<Frontmatter>; warnings: string[] } {
  const patch: Partial<Frontmatter> = {};
  const warnings: string[] = [];
  const fm = node.frontmatter as unknown as Record<string, unknown>;
  const label = node.id;

  const title = fm.title;
  if (typeof title !== "string" || title.trim() === "") {
    patch.title = firstHeading(node.body) ?? fallbackTitle;
  }

  const type = fm.type;
  if (type === undefined || type === null || String(type).trim() === "") {
    // A note that states no type is a document; write that down so the file
    // says what every reader already assumes. Derived, not invented — no
    // warning.
    patch.type = "document" as NodeType;
  } else if (!NODE_TYPE_SET.has(String(type))) {
    patch.type = "document" as NodeType;
    warnings.push(
      `${label}: type "${String(type)}" is not a Context Nest node type; imported as "document"`,
    );
  }

  // `parseDocument` has already normalized `tags` to a `#`-prefixed string
  // array (or dropped it); only the entries themselves are suspect here.
  if (Array.isArray(fm.tags)) {
    const before = fm.tags as unknown[];
    const { tags, warnings: tagWarnings } = sanitizeImportedTags(before, label);
    warnings.push(...tagWarnings);
    const unchanged =
      before.length === tags.length && before.every((t, i) => t === tags[i]);
    if (!unchanged) patch.tags = tags;
  }

  return { patch, warnings };
}
