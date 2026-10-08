/**
 * URI resolution: resolves contextnest:// URIs to documents (§4.2).
 */

import MiniSearch from "minisearch";
import type { ContextNode, ContextNestUri, Checkpoint } from "./types.js";
import { extractSection } from "./inline.js";
import { stripTagPrefix, isPublished, isForgotten } from "./parser.js";
import { FederationNotSupportedError, ForgottenVersionError } from "./errors.js";

/**
 * What a URI for a forgotten node resolves to (§6.3.3): the node, marked
 * `status: forgotten`, with an EMPTY body — never null. An agent learns the
 * memory was deliberately removed, which is different information from "never
 * existed", and MUST NOT treat the stub as content. `version` pins the view to
 * the version a checkpoint named, when that version is what was forgotten.
 */
export function forgottenView(doc: ContextNode, version?: number): ContextNode {
  return {
    ...doc,
    frontmatter: {
      ...doc.frontmatter,
      status: "forgotten",
      ...(version !== undefined ? { version } : {}),
    },
    body: "",
    rawContent: "",
  };
}

/**
 * English function words dropped from both the index and the query. Hosts pass
 * the user's question straight through ("what is the refund policy for…"), and
 * with these indexed every node containing "the" was an OR hit — and got cited.
 */
const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our should so than that the their them then there these they this those to was we were " +
    "what when where which who whom why will with would you your").split(" "),
);

/** MiniSearch `processTerm`: lowercase, and drop stopwords (null = not indexed/searched). */
export function processSearchTerm(term: string): string | null {
  const t = term.toLowerCase();
  return STOPWORDS.has(t) ? null : t;
}

/** A title or tag hit says more about what a node is ABOUT than a body mention. */
const SEARCH_BOOST = { title: 3, tags: 2, description: 1.5 };

/**
 * Partial (not-every-term) hits scoring below this fraction of the best hit are
 * dropped: a node sharing one term with the question, buried in an unrelated
 * page, is noise a host would otherwise cite. Full-term hits are always kept.
 */
// ponytail: fixed heuristic. A one-of-three-terms hit in a tiny vault scores ~0.08x
// the top; a one-term mention buried in an unrelated page ~0.01x. Tune here,
// or move to a semantic re-rank if fixed ratios stop separating them.
const MIN_RELATIVE_SCORE = 0.05;

export interface ResolverOptions {
  /** All documents in the vault */
  documents: ContextNode[];
  /** Checkpoint history for pinned resolution */
  checkpoints?: Checkpoint[];
  /** Function to reconstruct a specific version of a document */
  reconstructVersion?: (docId: string, version: number) => Promise<string>;
}

/** One full-text hit: the document plus its MiniSearch (BM25) score. */
export interface SearchHit {
  document: ContextNode;
  score: number;
}

export class Resolver {
  private documents: Map<string, ContextNode>;
  private tagIndex: Map<string, Set<string>>;
  private searchIndex: MiniSearch;
  private checkpoints: Checkpoint[];
  private reconstructVersion?: (docId: string, version: number) => Promise<string>;

  constructor(options: ResolverOptions) {
    this.documents = new Map();
    this.tagIndex = new Map();
    this.checkpoints = options.checkpoints || [];
    this.reconstructVersion = options.reconstructVersion;

    // Index all documents
    for (const doc of options.documents) {
      this.documents.set(doc.id, doc);

      // Build tag index
      for (const normalized of stripTagPrefix(doc.frontmatter.tags || [])) {
        if (!this.tagIndex.has(normalized)) {
          this.tagIndex.set(normalized, new Set());
        }
        this.tagIndex.get(normalized)!.add(doc.id);
      }
    }

    // Build full-text search index
    this.searchIndex = new MiniSearch({
      fields: ["title", "description", "body", "tags"],
      storeFields: ["id"],
      idField: "id",
      processTerm: processSearchTerm,
      searchOptions: { boost: SEARCH_BOOST },
    });

    const searchDocs = options.documents
      .filter(isPublished)
      .map((d) => ({
        id: d.id,
        title: d.frontmatter.title,
        description: d.frontmatter.description || "",
        body: d.body,
        tags: (d.frontmatter.tags || []).join(" "),
      }));

    this.searchIndex.addAll(searchDocs);
  }

  /**
   * Resolve a parsed URI to matching documents.
   * Only returns published documents by default.
   */
  async resolve(
    uri: ContextNestUri,
    options: { includeDrafts?: boolean } = {},
  ): Promise<ContextNode[]> {
    // Reject federated URIs for now
    if (uri.namespace) {
      throw new FederationNotSupportedError(uri.namespace);
    }

    switch (uri.kind) {
      case "document":
        return this.resolveDocument(uri, options);
      case "tag":
        return this.resolveTag(uri, options);
      case "folder":
        return this.resolveFolder(uri, options);
      case "search":
        return this.resolveSearch(uri);
      default:
        return [];
    }
  }

  private async resolveDocument(
    uri: ContextNestUri,
    options: { includeDrafts?: boolean },
  ): Promise<ContextNode[]> {
    // Pinned resolution
    if (uri.checkpoint !== undefined) {
      return this.resolvePinned(uri);
    }

    // Floating resolution: latest published version
    const doc = this.documents.get(uri.path);
    if (!doc) return [];

    // Forgotten resolves to `forgotten`, not to nothing (§6.3.3) — whatever
    // the draft setting, and with no section to extract from an empty stub.
    if (isForgotten(doc)) return [forgottenView(doc)];

    if (!options.includeDrafts && !isPublished(doc)) {
      return [];
    }

    // If anchor is specified, extract section
    if (uri.anchor) {
      const section = extractSection(doc.body, uri.anchor);
      if (section === null) return [];
      // Return a copy with the body replaced by the section content
      return [{ ...doc, body: section }];
    }

    return [doc];
  }

  private async resolvePinned(uri: ContextNestUri): Promise<ContextNode[]> {
    const checkpoint = this.checkpoints.find(
      (c) => c.checkpoint === uri.checkpoint,
    );
    if (!checkpoint) return [];

    const version = checkpoint.document_versions[uri.path];
    const doc = this.documents.get(uri.path);
    // Pinned or floating, a forgotten node resolves to `forgotten` (§6.3.3) —
    // whether checkpoint N still names its erased version or, from the
    // forget's own checkpoint on, no longer names it at all.
    if (doc && isForgotten(doc)) return [forgottenView(doc, version)];
    if (version === undefined) return [];

    if (!this.reconstructVersion) return [];

    let content: string;
    try {
      content = await this.reconstructVersion(uri.path, version);
    } catch (err) {
      // Only that version (a forgotten range) was erased.
      if (err instanceof ForgottenVersionError && doc) return [forgottenView(doc, version)];
      throw err;
    }
    if (!doc) return [];

    // Return with reconstructed body
    return [{ ...doc, body: content, rawContent: content }];
  }

  private resolveTag(
    uri: ContextNestUri,
    options: { includeDrafts?: boolean },
  ): ContextNode[] {
    // Extract tag name from path: "tag/{name}"
    const tagName = uri.path.slice(4); // Remove "tag/"
    const docIds = this.tagIndex.get(tagName);
    if (!docIds) return [];

    return [...docIds]
      .map((id) => this.documents.get(id)!)
      .filter((d) => !isForgotten(d) && (options.includeDrafts || isPublished(d)));
  }

  private resolveFolder(
    uri: ContextNestUri,
    options: { includeDrafts?: boolean },
  ): ContextNode[] {
    const prefix = uri.path + "/";
    return [...this.documents.values()]
      .filter(
        (d) =>
          (d.id.startsWith(prefix) || d.id.startsWith(uri.path)) &&
          !isForgotten(d) &&
          (options.includeDrafts || isPublished(d)),
      );
  }

  private resolveSearch(uri: ContextNestUri): ContextNode[] {
    // Extract search query from path: "search/{query}"
    const query = uri.path.slice(7).replace(/\+/g, " "); // Remove "search/", decode + to space
    return this.search(query).map((h) => h.document);
  }

  /**
   * Ranked full-text search over published documents (title, description,
   * body, tags). Best hit first.
   *
   * Ordering is tiered: documents matching EVERY query term come first, then
   * partial matches; within a tier, descending BM25 score. MiniSearch's
   * default OR search already sums per-term contributions, so a doc hitting
   * three terms usually outscores one hitting a single term — but a short
   * doc that repeats one rare term can still edge past it, and on a large
   * vault "strategy roadmap 2026" would surface every node mentioning 2026.
   * The AND pass pins the full matches to the top; the OR pass keeps recall
   * when nothing matches every term. `score` is the BM25 score of the OR
   * pass (identical for a doc in both passes: same terms, same sum).
   *
   * Stopwords never match (see STOPWORDS), and partial hits far below the
   * best score are dropped (see MIN_RELATIVE_SCORE).
   */
  search(query: string): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const partial = this.searchIndex.search(q);
    if (partial.length === 0) return [];
    const full = new Set(this.searchIndex.search(q, { combineWith: "AND" }).map((r) => r.id));
    const tier = (id: unknown) => (full.has(id) ? 1 : 0);
    const floor = partial[0].score * MIN_RELATIVE_SCORE;
    // MiniSearch returns score-descending; the sort is stable, so this only
    // lifts the full-match tier without reshuffling within it.
    return partial
      .filter((r) => full.has(r.id) || r.score >= floor)
      .sort((a, b) => tier(b.id) - tier(a.id) || b.score - a.score)
      .map((r) => ({ document: this.documents.get(r.id as string), score: r.score }))
      .filter((h): h is SearchHit => h.document !== undefined);
  }

  /** Get a document by id (no filtering) */
  getDocument(id: string): ContextNode | undefined {
    return this.documents.get(id);
  }

  /** Get all published documents */
  getPublishedDocuments(): ContextNode[] {
    return [...this.documents.values()].filter(isPublished);
  }

  /** Get all documents */
  getAllDocuments(): ContextNode[] {
    return [...this.documents.values()];
  }
}
