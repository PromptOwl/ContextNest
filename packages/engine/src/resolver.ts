/**
 * URI resolution: resolves contextnest:// URIs to documents (§4.2).
 */

import MiniSearch from "minisearch";
import type { ContextNode, ContextNestUri, Checkpoint } from "./types.js";
import { extractSection } from "./inline.js";
import { stripTagPrefix, isPublished } from "./parser.js";
import { FederationNotSupportedError } from "./errors.js";

export interface ResolverOptions {
  /** All documents in the vault */
  documents: ContextNode[];
  /** Checkpoint history for pinned resolution */
  checkpoints?: Checkpoint[];
  /** Function to reconstruct a specific version of a document */
  reconstructVersion?: (docId: string, version: number) => Promise<string>;
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
    if (version === undefined) return [];

    if (!this.reconstructVersion) return [];

    const content = await this.reconstructVersion(uri.path, version);
    const doc = this.documents.get(uri.path);
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
      .filter((d) => options.includeDrafts || isPublished(d));
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
          (options.includeDrafts || isPublished(d)),
      );
  }

  private resolveSearch(uri: ContextNestUri): ContextNode[] {
    // Extract search query from path: "search/{query}"
    const query = uri.path.slice(7).replace(/\+/g, " "); // Remove "search/", decode + to space
    const results = this.searchIndex.search(query);
    return results
      .map((r) => this.documents.get(r.id as string))
      .filter((d): d is ContextNode => d !== undefined);
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
