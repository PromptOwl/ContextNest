/**
 * Document parsing and serialization.
 * Splits YAML frontmatter with js-yaml and validates it with Zod.
 */

import yaml from "js-yaml";
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
 * js-yaml auto-parses unquoted ISO timestamps into
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
const DELIMITER = "---";

/**
 * Split `---`-delimited YAML frontmatter from a markdown body.
 *
 * Deliberately narrow: YAML only, no excerpts, no sections, no language tag.
 * The delimiter handling mirrors what gray-matter did (which this replaced),
 * including tolerating CRLF and treating an all-comment block as empty.
 */
function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // `----` and friends are a thematic break, not an opening delimiter.
  if (!content.startsWith(DELIMITER) || content.charAt(DELIMITER.length) === "-") {
    return { data: {}, body: content };
  }

  const rest = content.slice(DELIMITER.length);
  const close = "\n" + DELIMITER;
  const closeIndex = rest.indexOf(close);

  const block = rest.slice(0, closeIndex === -1 ? rest.length : closeIndex);

  // A block of nothing but YAML comments carries no data.
  const stripped = block.replace(/^\s*#[^\n]+/gm, "").trim();
  const data = stripped === "" ? {} : ((yaml.load(block) as Record<string, unknown>) ?? {});

  if (closeIndex === -1) return { data, body: "" };

  let body = rest.slice(closeIndex + close.length);
  // Drop the line break that terminates the closing delimiter's own line.
  if (body[0] === "\r") body = body.slice(1);
  if (body[0] === "\n") body = body.slice(1);

  return { data, body };
}

export function parseDocument(
  filePath: string,
  content: string,
  id: string,
): ContextNode {
  const { data, body } = splitFrontmatter(content);
  const parsed = { data: data as Record<string, any>, content: body };

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

  // Copy so callers mutating the returned node cannot write back through the
  // object the YAML load produced.
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

  // Rule 1: Valid YAML frontmatter (the parse already enforced this; if it loaded, it's valid)
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

  // Rule 4: Context links use valid contextnest:// URIs.
  // The URI capture is length-bounded so the pattern stays linear on adversarial
  // bodies (many `](contextnest://` prefixes without a closing `)` would otherwise
  // backtrack polynomially — CodeQL js/polynomial-redos). Real URIs are far shorter.
  const linkPattern = /\]\(contextnest:\/\/([^)]{0,2048})\)/g;
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
  const normalized: Frontmatter =
    node.frontmatter.status !== undefined
      ? { ...node.frontmatter, status: normalizeStatus(node.frontmatter.status) }
      : { ...node.frontmatter };
  // Drop undefined-valued keys before dumping. js-yaml throws
  // "unacceptable kind of an object to dump [object Undefined]" on an undefined
  // value — and these arise from our OWN parser (e.g. normalizeTags() returns
  // undefined for empty tags, which parseDocument writes back into frontmatter).
  // The serializer must not choke on what parseDocument produces. Dropping an
  // undefined key is roundtrip-safe: an absent key and an undefined value parse
  // identically.
  //
  // NOTE: this is a SHALLOW strip — it only drops undefined values at the top
  // level of frontmatter. An undefined nested inside a frontmatter value (e.g.
  // `metadata: { x: undefined }`) would still reach the YAML dump and throw.
  // No current parser path produces that (normalizeTags is the only undefined
  // source and it sits top-level), so a deep strip is deliberately out of scope
  // here; revisit if a nested-optional frontmatter field is ever added.
  const fm = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  ) as Frontmatter;

  const body = node.body.endsWith("\n") ? node.body : node.body + "\n";
  const block = yaml.dump(fm).trim();
  // Empty frontmatter is written as a bare body, with no delimiters at all.
  if (block === "{}") return body;
  return `${DELIMITER}\n${block}\n${DELIMITER}\n${body}`;
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
