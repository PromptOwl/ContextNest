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
});
