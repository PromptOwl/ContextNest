/**
 * Document parsing and serialization.
 * Uses gray-matter for frontmatter extraction and Zod for validation.
 */

import matter from "gray-matter";
import { frontmatterSchema, STATUSES, STATUS_ALIASES } from "./schemas.js";
import type { ContextNode, Frontmatter, Status, ValidationError, ValidationResult } from "./types.js";

const CANONICAL_STATUS_SET: Set<string> = new Set(STATUSES);

/**
 * Normalize a raw frontmatter `status` value to a canonical `Status`.
 *
 *   - Canonical values pass through unchanged.
 *   - Aliases (case-insensitive) are mapped via `STATUS_ALIASES`.
 *   - Anything else (including `undefined`, `null`, non-strings) falls back
 *     to `"draft"`.
 *
 * Called by `parseDocument` so the rest of the engine never sees raw
 * status. Also called by `serializeDocument` so disk converges to canonical
 * on every write.
 */
export function normalizeStatus(raw: unknown): Status {
  if (typeof raw !== "string") return "draft";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "draft";
  const lower = trimmed.toLowerCase();
  if (CANONICAL_STATUS_SET.has(lower)) return lower as Status;
  const alias = STATUS_ALIASES[lower];
  if (alias) return alias;
  return "draft";
}

/** Normalize tags to always include the # prefix. Filters out null/undefined entries caused by YAML comment parsing. */
export function normalizeTags(tags?: unknown[]): string[] | undefined {
  if (!tags) return undefined;
  const valid = tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
  if (valid.length === 0) return undefined;
  return valid.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
}

/**
 * Coerce a frontmatter date-field value to an ISO-8601 string.
 *
 * js-yaml (used by gray-matter) auto-parses unquoted ISO timestamps into
 * JavaScript `Date` objects. The Frontmatter TypeScript type declares
 * `created_at`/`updated_at` as `string`, so downstream code (e.g.
 * `generateIndexMd` calling `.split("T")[0]`) crashes when given a Date.
 * Normalize to string at parse time so all consumers see a uniform shape.
 */
function normalizeDateField(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return undefined;
}

/** Strip # prefix from tags (for context.yaml output per §5) */
export function stripTagPrefix(tags: string[]): string[] {
  return tags.filter((tag) => typeof tag === "string").map((tag) => (tag.startsWith("#") ? tag.slice(1) : tag));
}

/** Predicate: document is in `draft` status (post-normalization). */
export function isDraft(node: ContextNode): boolean {
  return node.frontmatter.status === "draft";
}

/** Predicate: document is in `pending_review` status (post-normalization). */
export function isPendingReview(node: ContextNode): boolean {
  return node.frontmatter.status === "pending_review";
}

/** Predicate: document is in `approved` status (post-normalization). */
export function isApproved(node: ContextNode): boolean {
  return node.frontmatter.status === "approved";
}

/** Predicate: document is in `published` status (post-normalization). */
export function isPublished(node: ContextNode): boolean {
  return node.frontmatter.status === "published";
}

/** Predicate: document is in `rejected` status (post-normalization). */
export function isRejected(node: ContextNode): boolean {
  return node.frontmatter.status === "rejected";
}

/**
 * @deprecated The `superseded` status was removed. `parseDocument` normalizes
 * legacy `superseded` values to `draft`, so this predicate always returns
 * `false` for parsed nodes. Use `isRejected` for the terminal-hide state.
 */
export function isSuperseded(node: ContextNode): boolean {
  return node.frontmatter.status === ("superseded" as Status);
}

/**
 * Retrieval predicate — true when the node may surface to LLMs / context
 * APIs under any retrieval setting. Excludes `pending_review`, `approved`,
 * and `rejected`:
 *   - `rejected` is terminal hide (steward retired the doc).
 *   - `approved` is reviewer-signed-off but not yet live.
 *   - `pending_review` is submitted-for-review; reviewer has not signed off.
 * `draft` returns true here; `GraphQueryEngine` applies a second gate via
 * `includeDrafts`.
 */
export function isRetrievable(node: ContextNode): boolean {
  return isPublished(node) || isDraft(node);
}

/**
 * Parse a Context Nest document from its file content.
 * Returns the parsed ContextNode with validated frontmatter.
 */
export function parseDocument(
  filePath: string,
  content: string,
  id: string,
): ContextNode {
  const parsed = matter(content);

  // Normalize tags to include # prefix
  if (parsed.data.tags) {
    parsed.data.tags = normalizeTags(parsed.data.tags);
  }

  // Coerce auto-parsed Date values back to ISO strings so the runtime shape
  // matches the Frontmatter TypeScript type (see normalizeDateField).
  if (parsed.data.updated_at !== undefined) {
    parsed.data.updated_at = normalizeDateField(parsed.data.updated_at);
  }
  if (parsed.data.created_at !== undefined) {
    parsed.data.created_at = normalizeDateField(parsed.data.created_at);
  }

  // Normalize status to canonical before downstream consumers see it.
  // Aliases (`cancelled`, `superseded`, `active`, …) and unknown values are
  // resolved here so zod validation, predicates, retrieval filters, and
  // index generation all operate on canonical values. Done unconditionally: a
  // document with no `status` field (pre-v1.1 / hand-authored) defaults to
  // `draft` (normalizeStatus(undefined) === "draft") rather than staying
  // `undefined`, which `isRetrievable` would treat as neither published nor
  // draft — making the doc visible in listings but invisible to query/resolve.
  parsed.data.status = normalizeStatus(parsed.data.status);

  // Copy frontmatter so callers mutating returned node don't leak back into
  // gray-matter's internal parse state (gray-matter caches by input string;
  // reusing identical content across tests would otherwise share the same
  // object).
  const frontmatter = { ...parsed.data } as Frontmatter;

  return {
    id,
    filePath,
    frontmatter,
    body: parsed.content,
    rawContent: content,
  };
}

/**
 * Validate a document's frontmatter against the schema.
 * Returns a ValidationResult with all errors found.
 */
export function validateDocument(
  node: ContextNode,
): ValidationResult {
  const errors: ValidationError[] = [];

  // Rule 1: Valid YAML frontmatter (gray-matter handles this; if it parsed, it's valid)
  // Rule 3: Body is valid markdown (we trust the content is markdown)

  // Rules 2, 5-17: Zod schema validation
  const result = frontmatterSchema.safeParse(node.frontmatter);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join(".");
      let rule = 0;

      // Map Zod errors to spec rule numbers
      if (field === "title") rule = 2;
      else if (field.startsWith("tags")) rule = 5;
      else if (field === "type") rule = 6;
      else if (field === "status") rule = 7;
      else if (field === "checksum") rule = 8;
      else if (field === "source" && issue.message.includes("required")) rule = 9;
      else if (field === "source.transport") rule = 10;
      else if (field === "source.tools") rule = 11;
      else if (field === "source.server") rule = 12;
      else if (field.startsWith("source.depends_on")) rule = 13;
      else if (field === "source.cache_ttl") rule = 16;
      else if (field === "source" && issue.message.includes("must not")) rule = 17;

      errors.push({
        rule,
        path: node.id,
        message: issue.message,
        field: field || undefined,
      });
    }
  }

  // Rule 4: Context links use valid contextnest:// URIs
  const linkPattern = /\]\(contextnest:\/\/([^)]*)\)/g;
  let match;
  while ((match = linkPattern.exec(node.body)) !== null) {
    const uri = match[1];
    if (!uri || uri.includes("//")) {
      errors.push({
        rule: 4,
        path: node.id,
        message: `Invalid contextnest:// URI in link: contextnest://${uri}`,
        field: "body",
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Serialize a ContextNode back to file content.
 * Roundtrip-safe: parse(serialize(node)) === node.
 *
 * Status is normalized before write so disk converges to canonical values
 * even when a caller bypasses the parser (e.g. assembles a node literal).
 */
export function serializeDocument(node: ContextNode): string {
  const fm: Frontmatter =
    node.frontmatter.status !== undefined
      ? { ...node.frontmatter, status: normalizeStatus(node.frontmatter.status) }
      : node.frontmatter;
  return matter.stringify(node.body, fm);
}

/**
 * Compute the document body content for checksum calculation.
 * Per §1.5: SHA-256 of all content after the closing --- of frontmatter, including the leading newline.
 */
export function getChecksumContent(rawContent: string): string {
  // Everything after closing frontmatter delimiter, including leading newline.
  const fmEnd = rawContent.indexOf("---", rawContent.indexOf("---") + 3);
  if (fmEnd === -1) return rawContent;
  return rawContent.slice(fmEnd + 3);
}
