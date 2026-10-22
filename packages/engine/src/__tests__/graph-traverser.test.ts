import { describe, it, expect } from "vitest";
import { GraphTraverser } from "../graph-traverser.js";
import type {
  ContextYamlDocument,
  RelationshipEdge,
  HubEntry,
} from "../types.js";

// Helper to create a minimal ContextYamlDocument
function doc(id: string, tags: string[] = []): ContextYamlDocument {
  return {
    id,
    title: id.replace(/-/g, " "),
    type: "document",
    tags,
    status: "published",
    version: 1,
  };
}

function edge(from: string, to: string, type: "reference" | "depends_on" = "reference", priority?: number): RelationshipEdge {
  return { from, to, type, ...(priority !== undefined ? { priority } : {}) };
}

describe("GraphTraverser", () => {
  // Build a simple graph:
  //   A --ref--> B --ref--> C --ref--> D --ref--> E
  //   A --dep--> F
  //   B --ref--> G
  const documents = [
    doc("A"), doc("B"), doc("C"), doc("D"), doc("E"), doc("F"), doc("G"),
  ];
  const relationships: RelationshipEdge[] = [
    edge("A", "B"),
    edge("B", "C"),
    edge("C", "D"),
    edge("D", "E"),
    edge("A", "F", "depends_on"),
    edge("B", "G"),
  ];

  it("should return seeds plus free edges with 0 hops", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 0 });
    // A is the seed, F is reached via free depends_on edge
    expect(result.nodeIds).toEqual(new Set(["A", "F"]));
    // B is a reference edge (cost 1), not reachable at 0 hops
    expect(result.nodeIds).not.toContain("B");
  });

  it("should traverse 1 hop for reference edges", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 1 });
    // A -> B (1 hop ref), A -> F (free depends_on)
    expect(result.nodeIds).toContain("A");
    expect(result.nodeIds).toContain("B");
    expect(result.nodeIds).toContain("F");
    // C is 2 hops from A
    expect(result.nodeIds).not.toContain("C");
  });

  it("should traverse 2 hops", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 2 });
    expect(result.nodeIds).toContain("A");
    expect(result.nodeIds).toContain("B");
    expect(result.nodeIds).toContain("C");
    expect(result.nodeIds).toContain("F");
    expect(result.nodeIds).toContain("G");
    // D is 3 hops
    expect(result.nodeIds).not.toContain("D");
  });

  it("depends_on edges are always free (cost 0)", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 0 });
    // Even with 0 hops, depends_on edges are free
    expect(result.nodeIds).toContain("F");
  });

  it("edges TO hub nodes are free", () => {
    const hubs: HubEntry[] = [{ id: "C", degree: 5 }];
    const traverser = new GraphTraverser(documents, relationships, hubs);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 1 });
    // A -> B (1 hop), B -> C (free because C is hub)
    expect(result.nodeIds).toContain("C");
    // G is still reachable from B (1 hop from B, B is at 0 remaining from A)
    // but B was reached with 0 remaining, so G needs 1 more -> not reachable
    // Actually: A starts with remaining=1, B reached with remaining=0
    // From B: C is free (hub), G costs 1 (remaining 0 - 1 = -1 -> not reachable)
    expect(result.nodeIds).not.toContain("G");
  });

  it("walking back from a hub is not free", () => {
    // X, Y, Z all link to hub H. Seeding H at 0 hops must return H alone:
    // the free rule is for reaching a hub, not for leaving one.
    const docs = [doc("H"), doc("X"), doc("Y"), doc("Z")];
    const edges = [edge("X", "H"), edge("Y", "H"), edge("Z", "H")];
    const hubs: HubEntry[] = [{ id: "H", degree: 3 }];
    const traverser = new GraphTraverser(docs, edges, hubs);
    expect(traverser.traverse(new Set(["H"]), { maxHops: 0 }).nodeIds).toEqual(new Set(["H"]));
    // One hop back from the hub still reaches its backlinkers.
    expect(traverser.traverse(new Set(["H"]), { maxHops: 1 }).nodeIds).toEqual(
      new Set(["H", "X", "Y", "Z"]),
    );
    // Reaching the hub from a backlinker stays free.
    expect(traverser.traverse(new Set(["X"]), { maxHops: 0 }).nodeIds).toEqual(new Set(["X", "H"]));
  });

  it("walking back along depends_on (to a dependent) costs a hop", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    // A --dep--> F. From F at 0 hops, A (which depends on F) is not pulled in.
    expect(traverser.traverse(new Set(["F"]), { maxHops: 0 }).nodeIds).toEqual(new Set(["F"]));
    expect(traverser.traverse(new Set(["F"]), { maxHops: 1 }).nodeIds).toContain("A");
  });

  it("explicit priority 0 makes an edge free", () => {
    const customEdges: RelationshipEdge[] = [
      edge("A", "B", "reference", 0), // explicitly free
      edge("B", "C"),
    ];
    const traverser = new GraphTraverser(documents, customEdges, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 0 });
    // B should be reachable even with 0 hops because edge has priority 0
    expect(result.nodeIds).toContain("B");
  });

  it("follows edges in both directions", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    // Start from C and traverse backward
    const result = traverser.traverse(new Set(["C"]), { maxHops: 1 });
    // Forward: C -> D (1 hop)
    expect(result.nodeIds).toContain("D");
    // Backward: B -> C, so B is reachable (1 hop back)
    expect(result.nodeIds).toContain("B");
  });

  it("handles cycles without infinite loop", () => {
    const cyclicEdges: RelationshipEdge[] = [
      edge("A", "B"),
      edge("B", "C"),
      edge("C", "A"), // cycle back to A
    ];
    const traverser = new GraphTraverser(documents, cyclicEdges, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 10 });
    expect(result.nodeIds).toEqual(new Set(["A", "B", "C"]));
  });

  it("adaptive expansion increases hops when below minResults", () => {
    // Isolated node X with no edges — won't find neighbors at hops=1
    const isolatedDocs = [doc("X"), doc("Y")];
    const isolatedEdges: RelationshipEdge[] = [];
    const traverser = new GraphTraverser(isolatedDocs, isolatedEdges, []);

    const result = traverser.traverse(new Set(["X"]), {
      maxHops: 1,
      minResults: 3, // want 3 but only 1 exists
      maxAdaptiveHops: 5,
    });
    // Should still return just X (can't find more), but hopsUsed reflects expansion
    expect(result.nodeIds).toContain("X");
    expect(result.nodeIds.size).toBe(1);
  });

  it("handles multiple seed nodes", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["A", "D"]), { maxHops: 1 });
    // From A: B (1 hop), F (free)
    // From D: C (1 hop backward), E (1 hop forward)
    expect(result.nodeIds).toContain("A");
    expect(result.nodeIds).toContain("B");
    expect(result.nodeIds).toContain("F");
    expect(result.nodeIds).toContain("D");
    expect(result.nodeIds).toContain("C");
    expect(result.nodeIds).toContain("E");
  });

  it("reports edges traversed count", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["A"]), { maxHops: 1 });
    expect(result.edgesTraversed).toBeGreaterThan(0);
  });

  it("skips seed IDs not in the graph", () => {
    const traverser = new GraphTraverser(documents, relationships, []);
    const result = traverser.traverse(new Set(["nonexistent"]), { maxHops: 2 });
    expect(result.nodeIds.size).toBe(0);
  });
});
