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
 */
export function slugifyImportPath(relPath: string): string {
  const segments = String(relPath ?? "").split(/[/\\]/).filter(Boolean);
  return segments
    .map((segment, i) => {
      if (segment.startsWith(".") || CLEAN_SEGMENT.test(segment)) return segment;
      const isLast = i === segments.length - 1;
      const ext = isLast ? (segment.match(EXTENSION)?.[0] ?? "") : "";
      const stem = ext ? segment.slice(0, -ext.length) : segment;
      const slug = slugify(stem) || "untitled";
      return `${slug}${ext.toLowerCase()}`;
    })
    .join("/");
}

/** The first top-level `# Heading` in a markdown body, if there is one. */
export function firstHeading(body: string): string | undefined {
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  const text = match?.[1]?.trim();
  return text ? text : undefined;
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
  return bare.split(/[\s#]+/).filter(Boolean);
}

/**
 * Normalize an imported tag list: split pasted hashtag lists, drop entries
 * that fail the spec tag rule, prefix with `#`, de-duplicate. Returns the
 * tags to keep and one warning per dropped entry.
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
    for (const candidate of splitTagEntry(entry.trim())) {
      if (!TAG_PATTERN.test(candidate)) {
        warnings.push(
          `${label}: dropped tag "${entry}" (a tag must match ${TAG_PATTERN.source})`,
        );
        continue;
      }
      const tag = `#${candidate}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
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
