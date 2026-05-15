/**
 * Source node dependency graph and topological sort (§1.9.4).
 */

import toposort from "toposort";
import type { ContextNode } from "./types.js";
import { CircularDependencyError } from "./errors.js";

/**
 * Build a dependency adjacency list from source nodes' depends_on fields.
 */
export function buildDependencyGraph(
  sourceNodes: ContextNode[],
): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const node of sourceNodes) {
    const deps: string[] = [];
    if (node.frontmatter.source?.depends_on) {
      for (const dep of node.frontmatter.source.depends_on) {
        // Strip contextnest:// prefix
        const target = dep.replace("contextnest://", "");
        deps.push(target);
      }
    }
    graph.set(node.id, deps);
  }

  return graph;
}

/**
 * Topologically sort source nodes by their depends_on ordering.
 * Returns node IDs in hydration order (dependencies first).
 * Throws CircularDependencyError if cycles are detected.
 */
export function topologicalSortSources(
  sourceNodes: ContextNode[],
): string[] {
  const graph = buildDependencyGraph(sourceNodes);

  // Build edges for toposort: [dependency, dependent]
  const edges: Array<[string, string]> = [];
  const allIds = new Set<string>();

  for (const [nodeId, deps] of graph) {
    allIds.add(nodeId);
    for (const dep of deps) {
      allIds.add(dep);
      edges.push([dep, nodeId]);
    }
  }

  try {
    const sorted = toposort.array([...allIds], edges);
    // Filter to only include IDs that are in our source nodes
    const sourceIds = new Set(sourceNodes.map((n) => n.id));
    return sorted.filter((id) => sourceIds.has(id));
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("cycle")) {
      // Extract cycle nodes from error
      const cycle = detectCycles(sourceNodes);
      throw new CircularDependencyError(cycle || ["unknown"]);
    }
    throw err;
  }
}

/**
 * Order source nodes by topological sort, returning the actual ContextNodes.
 * Empty input → empty output. Wraps `topologicalSortSources` so callers do not
 * have to rebuild the id-to-node map themselves.
 */
export function orderSourceNodesTopologically(
  sources: ContextNode[],
): ContextNode[] {
  if (sources.length === 0) return [];
  const sortedIds = topologicalSortSources(sources);
  const sourceMap = new Map(sources.map((n) => [n.id, n]));
  return sortedIds
    .map((id) => sourceMap.get(id))
    .filter((n): n is ContextNode => n !== undefined);
}

/**
 * Detect cycles in the dependency graph.
 * Returns the first cycle found as an array of node IDs, or null if acyclic.
 */
export function detectCycles(sourceNodes: ContextNode[]): string[] | null {
  const graph = buildDependencyGraph(sourceNodes);

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): string[] | null {
    if (inStack.has(nodeId)) {
      // Found a cycle — extract it from path
      const cycleStart = path.indexOf(nodeId);
      return [...path.slice(cycleStart), nodeId];
    }
    if (visited.has(nodeId)) return null;

    visited.add(nodeId);
    inStack.add(nodeId);
    path.push(nodeId);

    const deps = graph.get(nodeId) || [];
    for (const dep of deps) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }

    path.pop();
    inStack.delete(nodeId);
    return null;
  }

  for (const nodeId of graph.keys()) {
    const cycle = dfs(nodeId);
    if (cycle) return cycle;
  }

  return null;
}
