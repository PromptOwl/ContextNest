/**
 * Graph-aware query engine.
 *
 * Uses context.yaml as a lightweight graph index to evaluate selectors
 * against metadata (no bodies), then traverses edges for N hops, and
 * only loads document bodies for the nodes actually reached.
 *
 * Falls back to full-load mode when context.yaml is missing or --full is set.
 */

import type {
  ContextNode,
  ContextYaml,
  GraphQueryResult,
} from "./types.js";
import type { BaseNestStorage } from "./storage/base.js";
import { Resolver } from "./resolver.js";
import { PackLoader } from "./packs.js";
import { ContextInjector } from "./injection.js";
import { GraphTraverser } from "./graph-traverser.js";
import { generateContextYaml } from "./index-generator.js";
import { isPublished, isRetrievable } from "./parser.js";
import { getLatestCheckpoint, getLatestCheckpointNumber } from "./checkpoint.js";
import { parseSelector } from "./selector/parser.js";
import { evaluateFromIndex } from "./selector/index-evaluator.js";
import { orderSourceNodesTopologically } from "./source-graph.js";
import { TraceLogger } from "./tracing.js";

export interface GraphQueryOptions {
  /** Number of hops from seed nodes (default: 2) */
  hops?: number;
  /** Force full-load mode (default: false) */
  full?: boolean;
  /** Include draft documents (default: false) */
  includeDrafts?: boolean;
}

export class GraphQueryEngine {
  constructor(private storage: BaseNestStorage) {}

  /**
   * Query the vault using graph traversal.
   *
   * 1. Load context.yaml (lightweight graph index)
   * 2. Evaluate selector against metadata-only docs → seed IDs
   * 3. Traverse edges from seeds for N hops → expanded node set
   * 4. Batch-load bodies only for reached nodes
   */
  async query(
    selector: string,
    options: GraphQueryOptions = {},
  ): Promise<GraphQueryResult> {
    const { hops = 2, full = false } = options;

    // Try graph mode first
    if (!full) {
      let contextYaml = await this.storage.readContextYaml();

      // Auto-generate context.yaml if missing
      if (!contextYaml) {
        console.error("[ctx] No context.yaml found. Auto-indexing vault...");
        contextYaml = await this.autoIndex();
      }

      if (contextYaml) {
        return this.graphQuery(selector, contextYaml, hops, options);
      }
    }

    // Full mode: existing behavior, with the same retrieval gates applied.
    return this.fullQuery(selector, options);
  }

  private async graphQuery(
    selector: string,
    contextYaml: { documents: any[]; relationships: any[]; hubs: any[] },
    maxHops: number,
    options: GraphQueryOptions,
  ): Promise<GraphQueryResult> {
    const traceLogger = new TraceLogger();

    // Load packs for pack-based selectors
    const packs = await this.storage.readPacks();
    const packLoader = new PackLoader(packs);

    // 1. Evaluate selector against context.yaml metadata (no bodies loaded)
    const ast = parseSelector(selector);
    const seedIds = await evaluateFromIndex(ast, contextYaml.documents, {
      packLoader: (id) => packLoader.get(id),
    });

    // 2. Traverse graph from seeds
    const traverser = new GraphTraverser(
      contextYaml.documents,
      contextYaml.relationships,
      contextYaml.hubs,
    );
    const traversal = traverser.traverse(seedIds, {
      maxHops,
      minResults: 1,
      maxAdaptiveHops: 5,
    });

    // 3. Batch-load bodies only for reached nodes
    const reachedIds = [...traversal.nodeIds];
    const docMap = await this.storage.readDocuments(reachedIds);

    // 4. Separate source nodes from regular documents
    const regularDocs: ContextNode[] = [];
    const sourceNodes: ContextNode[] = [];

    for (const doc of docMap.values()) {
      // Rejected + approved docs are never returned, even with includeDrafts.
      // Rejected = terminal hide (steward retired). Approved = signed off
      // but not yet live — surfaces only after publish.
      if (!isRetrievable(doc)) {
        continue;
      }
      if (!options.includeDrafts && !isPublished(doc)) {
        continue;
      }
      if (doc.frontmatter.type === "source") {
        sourceNodes.push(doc);
      } else {
        regularDocs.push(doc);
      }
    }

    // 5. Order source nodes topologically
    const orderedSourceNodes = orderSourceNodesTopologically(sourceNodes);

    // 6. Log traces
    const checkpointHistory = await this.storage.readCheckpointHistory();
    const currentCheckpoint = getLatestCheckpointNumber(checkpointHistory);

    for (const doc of [...regularDocs, ...orderedSourceNodes]) {
      traceLogger.logAccess({
        documentRef: `contextnest://${doc.id}`,
        documentVersion: doc.frontmatter.version || 1,
        checkpoint: currentCheckpoint,
        author: doc.frontmatter.author,
        editedAt: doc.frontmatter.updated_at,
      });
    }

    return {
      documents: regularDocs,
      sourceNodes: orderedSourceNodes,
      traces: traceLogger.getTraces(),
      hopsUsed: traversal.hopsUsed,
      nodesTraversed: traversal.nodeIds.size,
      mode: "graph",
    };
  }

  /**
   * Auto-generate context.yaml when it's missing.
   * This makes upgrades seamless — first query triggers indexing.
   */
  private async autoIndex(): Promise<ContextYaml | null> {
    try {
      const docs = await this.storage.discoverDocuments();
      const config = await this.storage.readConfig();
      const checkpointHistory = await this.storage.readCheckpointHistory();
      const latestCheckpoint = getLatestCheckpoint(checkpointHistory);
      const published = docs.filter(isPublished);

      const contextYaml = generateContextYaml(published, config, latestCheckpoint);
      await this.storage.writeContextYaml(contextYaml);
      console.error("[ctx] Auto-index complete. context.yaml generated.");
      return contextYaml;
    } catch {
      console.error("[ctx] Auto-index failed. Falling back to full mode.");
      return null;
    }
  }

  /** Fallback: full-load mode (existing behavior, post-filtered by status). */
  private async fullQuery(
    selector: string,
    options: GraphQueryOptions = {},
  ): Promise<GraphQueryResult> {
    // discoverDocuments excludes rejected by default, so the resolver
    // never sees retired docs (parity with the graph-mode filter above).
    const docs = await this.storage.discoverDocuments();
    const packs = await this.storage.readPacks();
    const checkpointHistory = await this.storage.readCheckpointHistory();
    const currentCheckpoint = getLatestCheckpointNumber(checkpointHistory);

    const resolver = new Resolver({ documents: docs });
    const packLoader = new PackLoader(packs);
    const injector = new ContextInjector({
      resolver,
      packLoader,
      currentCheckpoint,
    });

    const result = await injector.inject(selector);

    // Apply the same retrieval gates as graphQuery so approved/rejected
    // never leak to LLMs, and drafts surface only when explicitly opted in.
    const filteredDocs = result.documents.filter((doc) => {
      if (!isRetrievable(doc)) return false;
      if (!options.includeDrafts && !isPublished(doc)) return false;
      return true;
    });
    const filteredSources = result.sourceNodes.filter((doc) => {
      if (!isRetrievable(doc)) return false;
      if (!options.includeDrafts && !isPublished(doc)) return false;
      return true;
    });

    return {
      ...result,
      documents: filteredDocs,
      sourceNodes: filteredSources,
      hopsUsed: 0,
      nodesTraversed: docs.length,
      mode: "full",
    };
  }
}
