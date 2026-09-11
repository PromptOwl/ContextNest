/**
 * Context injection orchestration (§9.1).
 * Resolves selectors, orders source nodes topologically,
 * and returns documents with trace entries.
 */

import type { ClientMetadata, ContextNode, ResolvedResult } from "./types.js";
import { Resolver } from "./resolver.js";
import { PackLoader } from "./packs.js";
import { parseSelector } from "./selector/parser.js";
import { evaluate } from "./selector/evaluator.js";
import { orderSourceNodesTopologically } from "./source-graph.js";
import { TraceLogger } from "./tracing.js";

export interface InjectorOptions {
  resolver: Resolver;
  packLoader: PackLoader;
  currentCheckpoint: number;
  /**
   * Caller metadata (§9.4) stamped on every access trace this injector emits,
   * so a §9.2 provenance record names the agent and session that read the
   * document, not only the document.
   */
  client?: ClientMetadata;
}

export class ContextInjector {
  private resolver: Resolver;
  private packLoader: PackLoader;
  private traceLogger: TraceLogger;
  private currentCheckpoint: number;
  private client?: ClientMetadata;

  constructor(options: InjectorOptions) {
    this.resolver = options.resolver;
    this.packLoader = options.packLoader;
    this.traceLogger = new TraceLogger();
    this.currentCheckpoint = options.currentCheckpoint;
    this.client = options.client;
  }

  /**
   * Inject context for a selector query.
   * Returns resolved documents with source nodes ordered topologically.
   */
  async inject(selector: string): Promise<ResolvedResult> {
    const ast = parseSelector(selector);

    const matchedDocs = await evaluate(ast, {
      resolver: this.resolver,
      packLoader: (id) => this.packLoader.get(id),
    });

    // Separate source nodes from regular documents
    const regularDocs: ContextNode[] = [];
    const sourceNodes: ContextNode[] = [];

    for (const doc of matchedDocs) {
      if (doc.frontmatter.type === "source") {
        sourceNodes.push(doc);
      } else {
        regularDocs.push(doc);
      }
    }

    // Order source nodes topologically for hydration
    const orderedSourceNodes = orderSourceNodesTopologically(sourceNodes);

    // Log access traces for all returned documents
    for (const doc of [...regularDocs, ...orderedSourceNodes]) {
      this.traceLogger.logAccess({
        documentRef: `contextnest://${doc.id}`,
        documentVersion: doc.frontmatter.version || 1,
        checkpoint: this.currentCheckpoint,
        author: doc.frontmatter.author,
        editedAt: doc.frontmatter.updated_at,
        client: this.client,
      });
    }

    return {
      documents: regularDocs,
      sourceNodes: orderedSourceNodes,
      traces: this.traceLogger.getTraces(),
    };
  }

  /** Get the trace logger for external hydration trace logging */
  getTraceLogger(): TraceLogger {
    return this.traceLogger;
  }
}
