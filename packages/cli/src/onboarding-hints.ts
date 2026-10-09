/**
 * First-run guidance for `ctx add` / `ctx search`. Pure helpers, so every
 * branch is unit-testable without a vault.
 */

/** Folders a structured vault's discovery scans (storage.discoverDocuments). */
const DISCOVERED_ROOTS = new Set(["nodes", "sources"]);

/**
 * In a structured vault, discovery only scans root-level files, `nodes/**` and
 * `sources/**`. A document written anywhere else exists on disk but never
 * shows up in list, search or agent context. Re-root such an id under `nodes/`
 * so the write is visible; obsidian vaults discover every folder, so leave
 * them alone.
 */
export function rerootForDiscovery(
  id: string,
  layout: "structured" | "obsidian",
): { id: string; rerooted: boolean } {
  if (layout !== "structured" || !id.includes("/")) return { id, rerooted: false };
  const first = id.split("/")[0];
  if (DISCOVERED_ROOTS.has(first)) return { id, rerooted: false };
  return { id: `nodes/${id}`, rerooted: true };
}

interface HeldCandidate {
  frontmatter: { status?: string; title?: string; tags?: unknown };
  body?: string;
}

/**
 * How many documents held for review (status `pending_review`) match any term
 * of the query. Search is published-only by design; this only lets the CLI say
 * why a fresh document is missing from the results.
 */
export function countHeldMatches(docs: HeldCandidate[], query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  return docs.filter((d) => {
    if (d.frontmatter.status !== "pending_review") return false;
    const tags = Array.isArray(d.frontmatter.tags) ? d.frontmatter.tags.join(" ") : "";
    const text = `${d.frontmatter.title ?? ""} ${d.body ?? ""} ${tags}`.toLowerCase();
    return terms.some((t) => text.includes(t));
  }).length;
}

/** The line `ctx search` prints when held documents match. */
export function heldSearchHint(n: number): string {
  return n === 1
    ? "1 matching document is held for review and not searchable until approved: ctx review list"
    : `${n} matching documents are held for review and not searchable until approved: ctx review list`;
}
