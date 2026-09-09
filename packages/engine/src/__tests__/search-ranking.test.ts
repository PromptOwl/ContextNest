/**
 * `context_search` ranking — CU-wdqcq01c5w.
 *
 * On a real vault `ctx search "strategy roadmap 2026"` returned 607 hits with
 * the first screen sorted by document id: the selector evaluator collapsed the
 * resolver's score-ordered hits into a Set and re-filtered the discovery list,
 * and the hyphen-slugified query ran as an OR search. These tests pin the
 * contract at the engine layer, independent of the CLI:
 *
 *  - hits come back best-first, with a numeric `score` on each;
 *  - a document matching every query term outranks one matching a single
 *    term, regardless of how the ids sort;
 *  - drafts never surface; `limit` truncates but `total` still counts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { Resolver } from "../resolver.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

interface Hit {
  id: string;
  score?: number;
}

async function makeContext(): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-search-rank-"));
  const storage = new NestStorage(dir);
  return {
    dir,
    ctx: {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    },
  };
}

describe("context_search — relevance ranking", () => {
  let ctx: OperationContext;
  let dir: string;
  const api = createEngineApi();

  // Ids are chosen so that discovery (alphabetical) order is the OPPOSITE of
  // relevance order: the partial match sorts first on disk, the full match
  // last. A pass here proves ordering comes from the score, not the listing.
  beforeEach(async () => {
    ({ ctx, dir } = await makeContext());
    await api.run("context_create", {
      id: "nodes/z-full",
      title: "Z Full",
      content: "alpha beta gamma",
    }, ctx);
    await api.run("context_create", {
      id: "nodes/a-partial",
      title: "A Partial",
      content: "alpha",
    }, ctx);
    await api.run("context_create", {
      id: "nodes/m-other",
      title: "M Other",
      content: "zzz",
    }, ctx);
    // A draft carrying every term must never be returned.
    await api.run("context_create", {
      id: "nodes/b-draft",
      title: "B Draft",
      content: "alpha beta gamma",
      publish: false,
    }, ctx);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the all-terms match first, the single-term match second, and no non-match", async () => {
    const { results } = await api.run<{ results: Hit[] }>(
      "context_search",
      { query: "alpha beta gamma" },
      ctx,
    );
    expect(results.map((r) => r.id)).toEqual(["nodes/z-full", "nodes/a-partial"]);
  });

  it("attaches a numeric score to every hit, descending", async () => {
    const { results } = await api.run<{ results: Hit[] }>(
      "context_search",
      { query: "alpha beta gamma" },
      ctx,
    );
    expect(results).toHaveLength(2);
    for (const r of results) expect(typeof r.score).toBe("number");
    expect(results[0].score!).toBeGreaterThan(results[1].score!);
  });

  it("never returns a draft, even one matching every term", async () => {
    const { results } = await api.run<{ results: Hit[] }>(
      "context_search",
      { query: "alpha beta gamma" },
      ctx,
    );
    expect(results.map((r) => r.id)).not.toContain("nodes/b-draft");
  });

  it("`limit` truncates the ranked list but `total` still reports every match", async () => {
    const out = await api.run<{ results: Hit[]; total: number }>(
      "context_search",
      { query: "alpha beta gamma", limit: 1 },
      ctx,
    );
    expect(out.results.map((r) => r.id)).toEqual(["nodes/z-full"]);
    expect(out.total).toBe(2);
  });

  it("the full-mode `contextnest://search/` query path keeps the ranked order too", async () => {
    // Same bug, one layer down: the selector evaluator used to re-sort the
    // resolver's hits into discovery order.
    const result = await ctx.query.query("contextnest://search/alpha-beta-gamma", {
      full: true,
    });
    expect(result.documents.map((d) => d.id)).toEqual(["nodes/z-full", "nodes/a-partial"]);
  });
});

describe("Resolver.search — tiered ranking", () => {
  function node(id: string, body: string, status = "published") {
    return {
      id,
      frontmatter: { title: id, type: "document", status, version: 1 },
      body,
      rawContent: body,
    } as any;
  }

  it("a document matching every term outranks one that repeats a single term", () => {
    // Term frequency alone would let the spammy single-term doc win; the
    // all-terms tier must sit above every partial match.
    const resolver = new Resolver({
      documents: [
        node("nodes/spam", "alpha ".repeat(60)),
        node("nodes/full", "some words alpha then beta and finally gamma here"),
        node("nodes/none", "zzz"),
      ],
    });
    const hits = resolver.search("alpha beta gamma");
    expect(hits.map((h) => h.document.id)).toEqual(["nodes/full", "nodes/spam"]);
  });

  it("falls back to partial matches when no document has every term", () => {
    const resolver = new Resolver({
      documents: [node("nodes/only-alpha", "alpha"), node("nodes/none", "zzz")],
    });
    const hits = resolver.search("alpha nonexistentterm");
    expect(hits.map((h) => h.document.id)).toEqual(["nodes/only-alpha"]);
  });

  it("ignores drafts and blank queries", () => {
    const resolver = new Resolver({
      documents: [node("nodes/draft", "alpha", "draft"), node("nodes/pub", "alpha")],
    });
    expect(resolver.search("alpha").map((h) => h.document.id)).toEqual(["nodes/pub"]);
    expect(resolver.search("   ")).toEqual([]);
  });
});
