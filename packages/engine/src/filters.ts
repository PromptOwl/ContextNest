import type { ContextNode } from "./types.js";
import { normalizeStatus } from "./parser.js";

/**
 * Filters accepted by {@link filterDocuments} and by the `context_list`
 * operation that wraps it.
 */
export interface DocumentFilters {
  /** One node type, or several to keep (e.g. every runnable type). */
  type?: string | readonly string[];
  /** Tag to match. The leading `#` is optional and case is ignored. */
  tag?: string;
  /** Lifecycle status. Aliases are normalized before comparing. */
  status?: string;
  /** Max documents to return, applied last. */
  limit?: number;
  /**
   * Keep retired nodes even when no `status` filter is given. Off by default,
   * matching ordinary retrieval. Governed surfaces set it: there a rejected
   * document is still something the caller may need to see and act on, rather
   * than something removed from the vault.
   */
  includeRetired?: boolean;
}

/**
 * Narrow a discovered document list by type / tag / status / limit.
 *
 * Shared so every surface filters identically — the CLI, the MCP server and
 * Community each grew their own copy of this and each got a different subset of
 * the rules right. Callers pass their own document list rather than a storage
 * handle, because Community filters documents it has already read and gated.
 *
 * Note the caller must discover with `{ includeRetired: true }` for a
 * `status: "rejected"` filter to have anything to match: retired documents are
 * dropped at discovery otherwise, and the filter then runs on a list they were
 * never in.
 */
export function filterDocuments(
  docs: readonly ContextNode[],
  filters: DocumentFilters = {},
): ContextNode[] {
  let out = [...docs];

  if (filters.type) {
    const wanted = new Set(
      typeof filters.type === "string" ? [filters.type] : filters.type,
    );
    // Default to "document": the field is optional in frontmatter, and a
    // literal comparison silently skips every document that omits it — which
    // is most of them.
    out = out.filter((d) => wanted.has(d.frontmatter.type ?? "document"));
  }

  if (filters.status) {
    const wanted = normalizeStatus(filters.status);
    out = out.filter(
      (d) => normalizeStatus(d.frontmatter.status ?? "draft") === wanted,
    );
  } else if (!filters.includeRetired) {
    // No status asked for: keep retired documents out of ordinary retrieval,
    // the way every surface's default listing does.
    out = out.filter((d) => d.frontmatter.status !== "rejected");
  }

  if (filters.tag) {
    // Compare bare and case-insensitively. The parser `#`-prefixes tags on
    // read, so a filter value normalized the other way (`#` stripped) matches
    // nothing at all — a filter that silently returns empty is worse than one
    // that errors.
    const wanted = bareTag(filters.tag);
    out = out.filter((d) => d.frontmatter.tags?.some((t) => bareTag(t) === wanted));
  }

  return filters.limit ? out.slice(0, filters.limit) : out;
}

function bareTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").toLowerCase();
}
