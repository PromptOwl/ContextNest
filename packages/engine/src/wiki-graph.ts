/**
 * Wiki-link seed resolution + ungated graph traversal.
 *
 * The engine's selector grammar has no `[[Title]]` lexeme, so consumers
 * (the community server's query-routes) hand-rolled `[[Title]]` resolution and
 * a hop-BFS over the wikilink graph. These pure primitives move that PLUMBING
 * into the engine. Seam #3 of the engine↔community separation.
 *
 * SCOPE — deliberately UNGATED. Traversal returns the full neighborhood with
 * no draft/status/permission filtering. The eligibility GATE (which drafts a
 * caller may see, stewardship scope) is the commercial governed-retrieval
 * method and stays with the consumer: it filters BEFORE seeding and/or AFTER
 * traversal. These functions never load documents or read status — they operate
 * on whatever the consumer already loaded, so orchestration + gating stay out
 * of the engine.
 *
 * DRAFT: pure functions only. A storage-coupled convenience wrapper
 * (resolve+load+traverse in one call) can be added later if a consumer wants
 * it — left out here so loading and gating stay explicitly on the consumer.
 */

/** Minimal doc shape these primitives need — id + title + body. */
export interface WikiDocLike {
  id: string;
  frontmatter: { title?: string };
  body: string;
}

/**
 * Extract wiki-link targets from a markdown body.
 * Handles `[[Target]]` and `[[Target|alias]]` (alias dropped). Targets are
 * trimmed and de-duplicated; a target may be a title ("Onboarding") or a node
 * id ("nodes/onboarding").
 */
export function extractWikiLinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split("|")[0].trim();
    if (target) out.add(target);
  }
  return [...out];
}

/** Title → id lookup (exact + case-insensitive fallback) plus the id set. */
export interface WikiTitleIndex {
  /** exact frontmatter title → id */
  byTitle: Map<string, string>;
  /** lowercased title → id (case-insensitive fallback) */
  byTitleLower: Map<string, string>;
  /** known node ids */
  ids: Set<string>;
}

export function buildWikiTitleIndex(docs: WikiDocLike[]): WikiTitleIndex {
  const byTitle = new Map<string, string>();
  const byTitleLower = new Map<string, string>();
  const ids = new Set<string>();
  for (const doc of docs) {
    ids.add(doc.id);
    const title = doc.frontmatter?.title;
    if (typeof title === "string" && title.trim()) {
      // First writer wins on collision — deterministic given input order.
      if (!byTitle.has(title)) byTitle.set(title, doc.id);
      const lower = title.toLowerCase();
      if (!byTitleLower.has(lower)) byTitleLower.set(lower, doc.id);
    }
  }
  return { byTitle, byTitleLower, ids };
}

/** Resolve one wiki target (id or title, optionally wrapped in `[[ ]]`) to a node id. */
function resolveTarget(target: string, index: WikiTitleIndex): string | null {
  let t = target.trim();
  const wrapped = t.match(/^\[\[([^\]]+?)\]\]$/);
  if (wrapped) t = wrapped[1].split("|")[0].trim();
  if (index.ids.has(t)) return t; // it's already an id
  return index.byTitle.get(t) ?? index.byTitleLower.get(t.toLowerCase()) ?? null;
}

/**
 * Resolve `[[Title]]` / `[[nodes/id]]` / bare title|id seeds to node ids.
 * Unresolvable seeds (dangling links) are dropped. Result is de-duplicated.
 */
export function resolveWikiSeeds(seeds: string[], index: WikiTitleIndex): string[] {
  const out = new Set<string>();
  for (const seed of seeds) {
    const id = resolveTarget(seed, index);
    if (id) out.add(id);
  }
  return [...out];
}

export interface WikiTraversalResult {
  /** Reached node ids, including the seeds. */
  nodeIds: string[];
  /** Deepest hop level actually reached. */
  hopsUsed: number;
}

/**
 * Breadth-first traversal over the (undirected) wiki-link graph from seed ids.
 * Edges run both directions: A→B if A's body links [[B]], and the reverse.
 * UNGATED — every reachable node within `hops` is returned regardless of
 * status; the consumer is responsible for gating before/after.
 */
export function traverseWikiGraph(
  seedIds: string[],
  docs: WikiDocLike[],
  opts: { hops: number },
): WikiTraversalResult {
  const index = buildWikiTitleIndex(docs);
  // Build undirected adjacency from resolved wiki links.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (const doc of docs) {
    for (const target of extractWikiLinks(doc.body)) {
      const to = resolveTarget(target, index);
      if (to) link(doc.id, to);
    }
  }

  const hops = Math.max(0, opts.hops | 0);
  const visited = new Set<string>();
  let frontier: string[] = [];
  for (const s of seedIds) {
    if (index.ids.has(s) && !visited.has(s)) {
      visited.add(s);
      frontier.push(s);
    }
  }

  let hopsUsed = 0;
  for (let depth = 0; depth < hops && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nbr of adj.get(id) ?? []) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          next.push(nbr);
        }
      }
    }
    if (next.length) hopsUsed = depth + 1;
    frontier = next;
  }

  return { nodeIds: [...visited], hopsUsed };
}
