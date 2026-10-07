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
 *  - drafts never surface; `limit` truncates but `count` (and its deprecated
 *    alias `total`) still reports every match (issue #103).
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

  it("`limit` truncates the ranked list but `count` still reports every match", async () => {
    const out = await api.run<{ results: Hit[]; count: number; total: number }>(
      "context_search",
      { query: "alpha beta gamma", limit: 1 },
      ctx,
    );
    expect(out.results.map((r) => r.id)).toEqual(["nodes/z-full"]);
    expect(out.count).toBe(2);
    expect(out.total).toBe(out.count);
  });

  it("`count` equals the number of results when nothing is truncated", async () => {
    for (const input of [{ query: "alpha beta gamma" }, { query: "alpha beta gamma", limit: 50 }]) {
      const out = await api.run<{ results: Hit[]; count: number; total: number }>(
        "context_search",
        input,
        ctx,
      );
      expect(out.results).toHaveLength(2);
      expect(out.count).toBe(out.results.length);
      expect(out.total).toBe(out.count);
    }
  });

  it("`count` is 0 when nothing matches", async () => {
    const out = await api.run<{ results: Hit[]; count: number }>(
      "context_search",
      { query: "zzqx-no-such-term" },
      ctx,
    );
    expect(out).toMatchObject({ results: [], count: 0 });
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

/**
 * Natural-language questions — CU-wdqcq02018.
 *
 * Hosts (Hootie chat, agents) pass the user's question straight through as
 * the search text. Stopwords ("what", "is", "the", "for") were indexed and
 * OR-matched, so every node containing "the" came back as a hit and was
 * cited. A question must retrieve the nodes about its topic, and nothing
 * whose only overlap with it is filler words.
 */
describe("search — natural-language questions", () => {
  const QUESTION = "What is the refund policy for enterprise customers?";

  function node(id: string, title: string, body: string) {
    return {
      id,
      frontmatter: { title, type: "document", status: "published", version: 1 },
      body,
      rawContent: body,
    } as any;
  }

  const docs = [
    node("nodes/refunds", "Refund Policy", "Enterprise customers can request a refund within 30 days."),
    // Shares only stopwords with the question.
    node("nodes/onboarding", "Onboarding", "This is what the team does for the first week. It is the plan for it."),
    // Shares one meaningful term, buried in an unrelated page.
    node(
      "nodes/hiring",
      "Hiring Process",
      "Interview loop, take-home task, reference checks and offer review. " +
        "Panels meet weekly. We also talk to customers sometimes. " +
        "Feedback is due within two days of each interview round.",
    ),
  ];

  it("does not match a node whose only overlap is stopwords", () => {
    const ids = new Resolver({ documents: docs }).search(QUESTION).map((h) => h.document.id);
    expect(ids).not.toContain("nodes/onboarding");
  });

  it("returns the on-topic node first and drops a weak single-term match", () => {
    const ids = new Resolver({ documents: docs }).search(QUESTION).map((h) => h.document.id);
    expect(ids).toEqual(["nodes/refunds"]);
  });

  it("a title match outranks the same words repeated in another node's body", () => {
    const resolver = new Resolver({
      documents: [
        node("nodes/body-only", "Misc Notes", "refund policy refund policy"),
        node("nodes/titled", "Refund Policy", "Details are listed below for each plan."),
      ],
    });
    expect(resolver.search("refund policy").map((h) => h.document.id)[0]).toBe("nodes/titled");
  });

  it("a query of only stopwords returns nothing rather than everything", () => {
    expect(new Resolver({ documents: docs }).search("what is the")).toEqual([]);
  });

  describe("through context_search and context_query", () => {
    let ctx: OperationContext;
    let dir: string;
    const api = createEngineApi();

    beforeEach(async () => {
      ({ ctx, dir } = await makeContext());
      for (const d of docs) {
        await api.run("context_create", { id: d.id, title: d.frontmatter.title, content: d.body }, ctx);
      }
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("context_search returns only the on-topic node", async () => {
      const { results } = await api.run<{ results: Hit[] }>("context_search", { query: QUESTION }, ctx);
      expect(results.map((r) => r.id)).toEqual(["nodes/refunds"]);
    });

    it("context_query (graph mode) seeds only from the on-topic node", async () => {
      const { documents } = await api.run<{ documents: Hit[] }>(
        "context_query",
        { query: "contextnest://search/what-is-the-refund-policy-for-enterprise-customers" },
        ctx,
      );
      expect(documents.map((d) => d.id)).toEqual(["nodes/refunds"]);
    });

    it("context_query (full mode) agrees", async () => {
      const { documents } = await api.run<{ documents: Hit[] }>(
        "context_query",
        { query: "contextnest://search/what-is-the-refund-policy-for-enterprise-customers", full: true },
        ctx,
      );
      expect(documents.map((d) => d.id)).toEqual(["nodes/refunds"]);
    });
  });
});
