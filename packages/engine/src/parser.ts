/**
 * Document parsing and serialization.
 * Uses gray-matter for frontmatter extraction and Zod for validation.
 */

import matter from "gray-matter";
import { frontmatterSchema } from "./schemas.js";
import type { ContextNode, Frontmatter, ValidationError, ValidationResult } from "./types.js";

/** Normalize tags to always include the # prefix. Filters out null/undefined entries caused by YAML comment parsing. */
export function normalizeTags(tags?: unknown[]): string[] | undefined {
  if (!tags) return undefined;
  const valid = tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
  if (valid.length === 0) return undefined;
  return valid.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
}

/** Strip # prefix from tags (for context.yaml output per §5) */
export function stripTagPrefix(tags: string[]): string[] {
  return tags.filter((tag) => typeof tag === "string").map((tag) => (tag.startsWith("#") ? tag.slice(1) : tag));
}

/** Predicate: document is in `published` status. */
export function isPublished(node: ContextNode): boolean {
  return node.frontmatter.status === "published";
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

  const frontmatter = parsed.data as Frontmatter;

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
 * Roundtrip-safe: parse(serialize(node)) === node
 */
export function serializeDocument(node: ContextNode): string {
  return matter.stringify(node.body, node.frontmatter);
}

/**
 * Compute the document body content for checksum calculation.
 * Per §1.5: SHA-256 of all content after the closing --- of frontmatter, including the leading newline.
 */
export function getChecksumContent(rawContent: string): string {
  const parsed = matter(rawContent);
  // gray-matter's content is everything after frontmatter
  // We need to include the leading newline
  const fmEnd = rawContent.indexOf("---", rawContent.indexOf("---") + 3);
  if (fmEnd === -1) return rawContent;
  return rawContent.slice(fmEnd + 3);
}
