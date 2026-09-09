import { describe, it, expect } from "vitest";
import {
  extractWikiLinks,
  buildWikiTitleIndex,
  resolveWikiSeeds,
  traverseWikiGraph,
  type WikiDocLike,
} from "../wiki-graph.js";

/**
 * Seam #3 (plumbing) — wiki-link seed resolution + UNGATED traversal. Moves the
 * hand-rolled logic out of the community server's query-routes. The eligibility
 * gate is deliberately NOT here; these return the full neighborhood.
 */
const docs: WikiDocLike[] = [
  { id: "nodes/a", frontmatter: { title: "Alpha" }, body: "see [[Beta]] and [[Gamma|the third]]" },
  { id: "nodes/b", frontmatter: { title: "Beta" }, body: "links to [[Delta]]" },
  { id: "nodes/c", frontmatter: { title: "Gamma" }, body: "no links" },
  { id: "nodes/d", frontmatter: { title: "Delta" }, body: "back to [[Alpha]]" },
  { id: "nodes/x", frontmatter: { title: "Island" }, body: "unconnected [[Nonexistent]]" },
];

describe("extractWikiLinks", () => {
  it("extracts targets and drops the alias", () => {
    expect(extractWikiLinks("see [[Beta]] and [[Gamma|the third]]")).toEqual(["Beta", "Gamma"]);
  });
  it("de-duplicates and ignores empties", () => {
    expect(extractWikiLinks("[[X]] [[X]] [[]] text")).toEqual(["X"]);
  });
});

describe("resolveWikiSeeds", () => {
  const index = buildWikiTitleIndex(docs);
  it("resolves titles, wrapped links, ids, and is case-insensitive", () => {
    expect(resolveWikiSeeds(["Beta"], index)).toEqual(["nodes/b"]);
    expect(resolveWikiSeeds(["[[Gamma|x]]"], index)).toEqual(["nodes/c"]);
    expect(resolveWikiSeeds(["nodes/d"], index)).toEqual(["nodes/d"]);
    expect(resolveWikiSeeds(["alpha"], index)).toEqual(["nodes/a"]);
  });
  it("drops dangling seeds", () => {
    expect(resolveWikiSeeds(["Nonexistent"], index)).toEqual([]);
  });
});

describe("traverseWikiGraph", () => {
  it("hop 0 returns only the seed", () => {
    const r = traverseWikiGraph(["nodes/a"], docs, { hops: 0 });
    expect(r.nodeIds).toEqual(["nodes/a"]);
    expect(r.hopsUsed).toBe(0);
  });

  it("hop 1 reaches direct neighbors (both link directions)", () => {
    const r = traverseWikiGraph(["nodes/a"], docs, { hops: 1 });
    // Alpha links Beta + Gamma; Delta links back to Alpha (reverse edge)
    expect(new Set(r.nodeIds)).toEqual(new Set(["nodes/a", "nodes/b", "nodes/c", "nodes/d"]));
    expect(r.hopsUsed).toBe(1);
  });

  it("does not reach the disconnected island", () => {
    const r = traverseWikiGraph(["nodes/a"], docs, { hops: 5 });
    expect(r.nodeIds).not.toContain("nodes/x");
  });

  it("is ungated — a draft-status doc would still be returned (no status read)", () => {
    // The doc shape has no status; traversal must not depend on one.
    const r = traverseWikiGraph(["nodes/b"], docs, { hops: 1 });
    expect(new Set(r.nodeIds)).toEqual(new Set(["nodes/b", "nodes/a", "nodes/d"]));
  });

  it("hopsUsed saturates below the requested hops once the frontier empties", () => {
    // Alpha's whole component (b, c, d — d via the reverse edge) sits 1 hop out,
    // so requesting hops:5 still reports hopsUsed:1: the frontier empties after
    // hop 1. hopsUsed is the DEEPEST hop reached, not the hop count requested.
    const r = traverseWikiGraph(["nodes/a"], docs, { hops: 5 });
    expect(new Set(r.nodeIds)).toEqual(new Set(["nodes/a", "nodes/b", "nodes/c", "nodes/d"]));
    expect(r.hopsUsed).toBe(1);
  });

  it("walks a deep chain one level per hop and saturates at the end", () => {
    // Linear chain n1 → n2 → n3 → n4 → n5 → n6 (5 hops end-to-end).
    const chain: WikiDocLike[] = [
      { id: "nodes/n1", frontmatter: { title: "N1" }, body: "[[N2]]" },
      { id: "nodes/n2", frontmatter: { title: "N2" }, body: "[[N3]]" },
      { id: "nodes/n3", frontmatter: { title: "N3" }, body: "[[N4]]" },
      { id: "nodes/n4", frontmatter: { title: "N4" }, body: "[[N5]]" },
      { id: "nodes/n5", frontmatter: { title: "N5" }, body: "[[N6]]" },
      { id: "nodes/n6", frontmatter: { title: "N6" }, body: "leaf" },
    ];
    // Each extra hop reaches exactly one more node down the chain.
    expect(traverseWikiGraph(["nodes/n1"], chain, { hops: 1 }).nodeIds).toEqual([
      "nodes/n1", "nodes/n2",
    ]);
    expect(traverseWikiGraph(["nodes/n1"], chain, { hops: 3 }).nodeIds).toEqual([
      "nodes/n1", "nodes/n2", "nodes/n3", "nodes/n4",
    ]);
    // hops:4 reaches n5; the whole chain (n6) needs 5 hops.
    const four = traverseWikiGraph(["nodes/n1"], chain, { hops: 4 });
    expect(four.nodeIds).toEqual(["nodes/n1", "nodes/n2", "nodes/n3", "nodes/n4", "nodes/n5"]);
    expect(four.hopsUsed).toBe(4);
    const five = traverseWikiGraph(["nodes/n1"], chain, { hops: 5 });
    expect(five.nodeIds).toHaveLength(6); // full chain reached
    expect(five.hopsUsed).toBe(5);
    // Requesting MORE hops than the chain is deep saturates at 5.
    const nine = traverseWikiGraph(["nodes/n1"], chain, { hops: 9 });
    expect(nine.nodeIds).toHaveLength(6);
    expect(nine.hopsUsed).toBe(5);
  });

  it("drops a self-link (no self-edge, no infinite loop, no duplicate)", () => {
    const selfDocs: WikiDocLike[] = [
      { id: "nodes/loop", frontmatter: { title: "Loop" }, body: "recursive [[Loop]] and [[Other]]" },
      { id: "nodes/other", frontmatter: { title: "Other" }, body: "plain" },
    ];
    const r = traverseWikiGraph(["nodes/loop"], selfDocs, { hops: 2 });
    expect(new Set(r.nodeIds)).toEqual(new Set(["nodes/loop", "nodes/other"]));
    expect(r.hopsUsed).toBe(1);
    // A doc whose ONLY link is to itself has no real neighbor → hopsUsed 0.
    const lonely: WikiDocLike[] = [{ id: "nodes/z", frontmatter: { title: "Z" }, body: "[[Z]] only" }];
    const lr = traverseWikiGraph(["nodes/z"], lonely, { hops: 5 });
    expect(lr.nodeIds).toEqual(["nodes/z"]);
    expect(lr.hopsUsed).toBe(0);
  });

  it("title collision — resolves first-writer-wins, loser stays reachable via its own links", () => {
    const collide: WikiDocLike[] = [
      { id: "nodes/policy-hr", frontmatter: { title: "Policy" }, body: "HR. see [[Handbook]]" },
      { id: "nodes/policy-legal", frontmatter: { title: "Policy" }, body: "Legal. see [[Handbook]]" },
      { id: "nodes/handbook", frontmatter: { title: "Handbook" }, body: "links [[Policy]]" },
    ];
    const index = buildWikiTitleIndex(collide);
    // First writer wins the title→id map (input order), deterministically.
    expect(index.byTitle.get("Policy")).toBe("nodes/policy-hr");
    expect(resolveWikiSeeds(["Policy"], index)).toEqual(["nodes/policy-hr"]);
    // Reverse the input → the other doc wins (order-determined, not id-sorted).
    const rev = buildWikiTitleIndex([collide[1], collide[0], collide[2]]);
    expect(rev.byTitle.get("Policy")).toBe("nodes/policy-legal");
    // The collision LOSER is still reachable: its own body links [[Handbook]],
    // so the reverse edge connects it even though no title route points at it.
    const r = traverseWikiGraph(["nodes/handbook"], collide, { hops: 3 });
    expect(new Set(r.nodeIds)).toEqual(
      new Set(["nodes/handbook", "nodes/policy-hr", "nodes/policy-legal"]),
    );
  });

  it("traverses from multiple seeds across disconnected components", () => {
    // Seed both the connected graph and the island simultaneously.
    const r = traverseWikiGraph(["nodes/a", "nodes/x"], docs, { hops: 1 });
    expect(r.nodeIds).toContain("nodes/x"); // island reached because it's a seed
    expect(new Set(r.nodeIds)).toEqual(
      new Set(["nodes/a", "nodes/b", "nodes/c", "nodes/d", "nodes/x"]),
    );
  });

  it("silently drops an unresolved seed (expects already-resolved ids)", () => {
    // Passing a raw title instead of an id contributes nothing — no throw.
    const r = traverseWikiGraph(["Alpha"], docs, { hops: 1 });
    expect(r.nodeIds).toEqual([]);
    expect(r.hopsUsed).toBe(0);
  });
});
