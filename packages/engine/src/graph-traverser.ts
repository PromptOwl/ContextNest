/**
 * Graph traversal with hop-based depth control.
 * Uses context.yaml's pre-built graph to traverse from seed nodes
 * without loading document bodies.
 */

import type {
  ContextYamlDocument,
  RelationshipEdge,
  HubEntry,
  TraversalOptions,
  TraversalResult,
} from "./types.js";

interface QueueEntry {
  nodeId: string;
  remainingHops: number;
}

/**
 * BFS graph traverser with priority-weighted edge costs.
 *
 * Edge cost rules:
 * - `depends_on` edges: free (cost 0, always traversed)
 * - Edges TO a hub node: free (cost 0)
 * - Edges with explicit `priority: 0`: free
 * - `reference` edges: cost 1 hop (or explicit priority value)
 */
export class GraphTraverser {
  /** Forward adjacency: nodeId → outbound edges */
  private forward = new Map<string, RelationshipEdge[]>();
  /** Reverse adjacency: nodeId → inbound edges */
  private reverse = new Map<string, RelationshipEdge[]>();
  /** Set of hub node IDs (edges TO these are free) */
  private hubIds: Set<string>;
  /** All known node IDs from context.yaml */
  private allNodeIds: Set<string>;

  constructor(
    documents: ContextYamlDocument[],
    relationships: RelationshipEdge[],
    hubs: HubEntry[],
  ) {
    this.allNodeIds = new Set(documents.map((d) => d.id));
    this.hubIds = new Set(hubs.map((h) => h.id));

    // Build adjacency lists
    for (const edge of relationships) {
      // Forward: from → edge
      if (!this.forward.has(edge.from)) {
        this.forward.set(edge.from, []);
      }
      this.forward.get(edge.from)!.push(edge);

      // Reverse: to → edge
      if (!this.reverse.has(edge.to)) {
        this.reverse.set(edge.to, []);
      }
      this.reverse.get(edge.to)!.push(edge);
    }
  }

  /**
   * Traverse the graph from seed nodes using BFS with hop-cost accounting.
   * Supports adaptive expansion: if fewer than minResults nodes are reached,
   * retries with +1 hops up to maxAdaptiveHops.
   */
  traverse(seedIds: Set<string>, options: TraversalOptions): TraversalResult {
    const { maxHops, minResults = 1, maxAdaptiveHops = 5 } = options;

    let currentMaxHops = maxHops;
    let result: TraversalResult;

    // Adaptive loop: expand hops if too few results
    do {
      result = this.bfs(seedIds, currentMaxHops);
      if (result.nodeIds.size >= minResults || currentMaxHops >= maxAdaptiveHops) {
        break;
      }
      currentMaxHops++;
      result = { ...result, hopsUsed: currentMaxHops };
    } while (currentMaxHops <= maxAdaptiveHops);

    return result;
  }

  private bfs(seedIds: Set<string>, maxHops: number): TraversalResult {
    const visited = new Set<string>();
    const queue: QueueEntry[] = [];
    let edgesTraversed = 0;
    let actualMaxHop = 0;

    // Enqueue all seeds
    for (const id of seedIds) {
      if (this.allNodeIds.has(id)) {
        visited.add(id);
        queue.push({ nodeId: id, remainingHops: maxHops });
      }
    }

    let head = 0;
    while (head < queue.length) {
      const { nodeId, remainingHops } = queue[head++];
      const hopDepth = maxHops - remainingHops;
      if (hopDepth > actualMaxHop) actualMaxHop = hopDepth;

      // Get all edges from/to this node
      const outbound = this.forward.get(nodeId) || [];
      const inbound = this.reverse.get(nodeId) || [];

      for (const edge of outbound) {
        const neighbor = edge.to;
        if (visited.has(neighbor)) continue;

        const cost = this.edgeCost(edge);
        const newRemaining = remainingHops - cost;

        if (newRemaining >= 0) {
          visited.add(neighbor);
          queue.push({ nodeId: neighbor, remainingHops: newRemaining });
          edgesTraversed++;
        }
      }

      for (const edge of inbound) {
        const neighbor = edge.from;
        if (visited.has(neighbor)) continue;

        const cost = this.reverseEdgeCost(edge);
        const newRemaining = remainingHops - cost;

        if (newRemaining >= 0) {
          visited.add(neighbor);
          queue.push({ nodeId: neighbor, remainingHops: newRemaining });
          edgesTraversed++;
        }
      }
    }

    return {
      nodeIds: visited,
      hopsUsed: actualMaxHop,
      edgesTraversed,
    };
  }

  /**
   * Compute the hop cost for traversing an edge.
   * - depends_on: always free (cost 0)
   * - Edges TO a hub node: free (cost 0)
   * - Explicit priority 0: free
   * - reference edges: cost 1 (or explicit priority)
   */
  private edgeCost(edge: RelationshipEdge): number {
    // Explicit priority override
    if (edge.priority !== undefined) return edge.priority;

    // depends_on is always free
    if (edge.type === "depends_on") return 0;

    // Edges TO hub nodes are free
    if (this.hubIds.has(edge.to)) return 0;

    // Default: reference edges cost 1
    return 1;
  }

  /**
   * Hop cost for walking an edge backwards (from `edge.to` to `edge.from`).
   * The free rules above are about reaching a node cheaply, so they apply in
   * the direction of travel: walking back from a hub is not free (otherwise a
   * hub seed would pull in every document that links to it at zero cost), and
   * walking back along depends_on (to a dependent, not a dependency) costs a hop.
   * - Explicit priority: as given
   * - Walking back TO a hub node: free
   * - Everything else: cost 1
   */
  private reverseEdgeCost(edge: RelationshipEdge): number {
    if (edge.priority !== undefined) return edge.priority;
    if (this.hubIds.has(edge.from)) return 0;
    return 1;
  }
}
