/**
 * Retrieval modes — lexical stemming, published-only embeddings, hybrid RRF.
 * Spec: nest `nodes/dev/spec-retrieval-modes` (seed-selection-only reframe,
 * 2026-09-08; gate moved 2026-10-13).
 *
 * Every provider here is an in-process stub: no test touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { Resolver, processSearchTerm, DEFAULT_FIELD_BOOSTS, LEGACY_FIELD_BOOSTS } from "../resolver.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import {
  registerEmbeddingProvider,
  registerReranker,
  type EmbeddingProvider,
  type Reranker,
} from "../semantic/providers.js";
import {
  rrfFuse,
  RRF_K,
  DEFAULT_FUSION_WEIGHTS,
  rerankHits,
  selectPassages,
  DEFAULT_RERANK_TOP_N,
  type RankedHit,
} from "../semantic/hybrid.js";
import { splitPassages } from "../semantic/passages.js";
import { EMBEDDINGS_DIR } from "../semantic/embedding-store.js";
import {
  createBedrockEmbeddingProvider,
  createBedrockReranker,
  withBedrockRetry,
  parseRetryAfter,
  BedrockHttpError,
  isTransientTransportError,
  requestBatches,
} from "../semantic/bedrock.js";

interface Hit {
  id: string;
  score?: number;
  scores?: { lexical?: number; semantic?: number; rrf?: number; rerank?: number };
}
interface SearchOut {
  results: Hit[];
  count: number;
  mode: string;
}

function node(id: string, body: string, status = "published", extra: Record<string, unknown> = {}) {
  return {
    id,
    frontmatter: { title: id, type: "document", status, version: 1, ...extra },
    body,
    rawContent: body,
  } as any;
}

// ─── Stub embedder: a tiny "concept" space so paraphrases land together ─────

const CONCEPTS: string[][] = [
  ["angry", "upset", "furious", "escalation", "complaint"],
  ["customer", "customers", "client", "clients", "buyer"],
  ["refund", "reimbursement", "money"],
  ["deploy", "deployment", "release", "ship"],
  ["database", "migration", "migrations", "schema"],
];

let embedCalls: string[][] = [];

function conceptVector(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/);
  const v = CONCEPTS.map((c) => words.filter((w) => c.includes(w)).length);
  // A constant floor dimension keeps an all-zero text from being undefined.
  return [...v, 0.01];
}

const stubProvider: EmbeddingProvider = {
  name: "stub",
  model: "concepts-v1",
  async embed(texts) {
    embedCalls.push(texts);
    return texts.map(conceptVector);
  },
};

let rerankCalls = 0;
const reverseReranker: Reranker = {
  name: "stub",
  model: "reverse",
  // Scores documents in REVERSE input order, so a pass proves rerank reorders.
  async rerank(_query, documents, topN) {
    rerankCalls++;
    return documents
      .map((_, index) => ({ index, score: index / documents.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  },
};

registerEmbeddingProvider("stub", () => stubProvider);
registerReranker("stub", () => reverseReranker);

const SEARCH_CONFIG = `
search:
  embeddings:
    provider: stub
    model: concepts-v1
  rerank:
    provider: stub
    model: reverse
    top_n: 10
`;

async function makeVault(configExtra = SEARCH_CONFIG): Promise<{ ctx: OperationContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-retrieval-modes-"));
  await mkdir(join(dir, ".context"), { recursive: true });
  await writeFile(join(dir, ".context", "config.yaml"), `version: 1\nname: test\n${configExtra}`);
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

const api = createEngineApi();

// ─── 1. Stemming ────────────────────────────────────────────────────────────

describe("lexical search — English stemming", () => {
  it("Given a doc about a 'migration', When searching 'migrations', Then it is found", () => {
    const resolver = new Resolver({
      documents: [node("nodes/db", "How we run a database migration safely"), node("nodes/other", "zzz")],
    });
    expect(resolver.search("migrations").map((h) => h.document.id)).toEqual(["nodes/db"]);
  });

  it("Given 'deploying' in a doc, When searching 'deployed', Then the shared stem matches", () => {
    const resolver = new Resolver({ documents: [node("nodes/d", "Notes on deploying the gateway")] });
    expect(resolver.search("deployed").map((h) => h.document.id)).toEqual(["nodes/d"]);
  });

  it("stopwords are still dropped before stemming", () => {
    expect(processSearchTerm("The")).toBeNull();
    expect(processSearchTerm("what")).toBeNull();
    expect(processSearchTerm("Migrations")).toBe(processSearchTerm("migration"));
  });

  it("the selector search route stems too", async () => {
    const { ctx, dir } = await makeVault("");
    try {
      await api.run("context_create", { id: "nodes/db", title: "DB", content: "database migration runbook" }, ctx);
      const r = await ctx.query.query("contextnest://search/migrations", { full: true });
      expect(r.documents.map((d) => d.id)).toEqual(["nodes/db"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("lexical search — full-match-first tier is an option", () => {
  const docs = [
    node("nodes/spam", "alpha ".repeat(60)),
    node("nodes/full", "some words alpha then beta and finally gamma here"),
  ];

  it("Given the default, Then the all-terms doc is pinned first (unchanged behaviour)", () => {
    expect(new Resolver({ documents: docs }).search("alpha beta gamma")[0].document.id).toBe("nodes/full");
  });

  it("Given fullMatchFirst:false, Then order is pure BM25 score", () => {
    const hits = new Resolver({ documents: docs, fullMatchFirst: false }).search("alpha beta gamma");
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });
});

describe("lexical search — field boosts (benchmark: big title boost hurt NDCG)", () => {
  // One incidental title word vs a document that is about the topic in its body.
  const titled = {
    ...node("nodes/rollout-retro", "Lunch menu, parking passes and the offsite agenda for next quarter, plus who brings snacks to the Friday demo."),
    frontmatter: { title: "Rollout retro", type: "document", status: "published", version: 1 },
  };
  const onTopic = {
    ...node(
      "nodes/canary-guide",
      "How we run a canary rollout: ship to five percent, watch error budgets, then widen the rollout in stages. " +
        "A rollout halts automatically when latency regresses; the rollout owner decides on rollback.",
    ),
    frontmatter: { title: "Canary guide", type: "document", status: "published", version: 1 },
  };

  it("default boosts are all 1 (any title boost lowered NDCG once coordination was removed)", () => {
    expect(DEFAULT_FIELD_BOOSTS).toEqual({ title: 1, tags: 1, description: 1, body: 1 });
  });

  it("Given an on-topic body and an incidental title word, When searching that word, Then the on-topic doc ranks first", () => {
    const hits = new Resolver({ documents: [titled, onTopic] }).search("rollout");
    expect(hits.map((h) => h.document.id)).toEqual(["nodes/canary-guide", "nodes/rollout-retro"]);
  });

  it("Given the legacy boosts (title 3), Then the incidental title hit wins — the defect the new default fixes", () => {
    const hits = new Resolver({ documents: [titled, onTopic], fieldBoosts: LEGACY_FIELD_BOOSTS }).search("rollout");
    expect(hits[0].document.id).toBe("nodes/rollout-retro");
  });

  it("config search.field_boosts reaches context_search", async () => {
    const { ctx, dir } = await makeVault("search:\n  field_boosts:\n    title: 10\n");
    try {
      await api.run("context_create", { id: "nodes/a", title: "Rollout retro", content: "lunch parking snacks" }, ctx);
      await api.run("context_create", {
        id: "nodes/b", title: "Canary guide", content: "canary rollout then widen the rollout; rollout halts on regressions",
      }, ctx);
      const out = await api.run<SearchOut>("context_search", { query: "rollout" }, ctx);
      expect(out.results[0].id).toBe("nodes/a");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("lexical search — no coordination factor (plain BM25 sum)", () => {
  // Eight notes share the common vocabulary; one doc carries the rare,
  // discriminative term. MiniSearch's default multiplies a hit's score by how
  // many query terms it matched, which buries the rare-term doc under any doc
  // touching many common words.
  const filler = Array.from({ length: 8 }, (_, i) =>
    node(`nodes/filler-${i}`, `patient treatment study results ${"lorem ".repeat(i % 5)}`),
  );
  const rare = node("nodes/rare", "Pheochromocytoma resection: perioperative outcomes in a small cohort.");
  const common = node("nodes/common", "patient treatment study results and follow up notes");
  const docs = [...filler, rare, common];
  const query = "pheochromocytoma patient treatment study results risk";

  it("Given a long query, Then the doc with the rare discriminative term beats one matching many common terms", () => {
    const hits = new Resolver({ documents: docs }).search(query);
    expect(hits[0].document.id).toBe("nodes/rare");
  });

  it("Given coordination:true (legacy), Then the many-common-terms doc wins — the defect this removes", () => {
    const hits = new Resolver({ documents: docs, coordination: true }).search(query);
    expect(hits[0].document.id).toMatch(/^nodes\/filler-/);
  });

  it("scores are the plain BM25 sum: coordination:true is exactly matched-terms × the default score", () => {
    const plain = new Resolver({ documents: docs }).search(query);
    const legacy = new Resolver({ documents: docs, coordination: true }).search(query);
    const p = plain.find((h) => h.document.id === "nodes/common")!.score;
    const l = legacy.find((h) => h.document.id === "nodes/common")!.score;
    expect(l / p).toBeCloseTo(4, 6); // patient, treatment, study, results
  });
});

// ─── 2. RRF ─────────────────────────────────────────────────────────────────

describe("reciprocal rank fusion", () => {
  it("uses k0 = 60", () => {
    expect(RRF_K).toBe(60);
  });

  it("hybrid defaults to lexical 1 : semantic 2 (dev-set sweep, SciFact + NFCorpus)", () => {
    expect(DEFAULT_FUSION_WEIGHTS).toEqual({ lexical: 1, semantic: 2 });
  });

  it("Given two lists, Then a doc ranked well in both beats a doc first in only one", () => {
    const fused = rrfFuse([
      ["a", "b", "c"],
      ["b", "c", "a", "d"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c", "d"]);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("Given weights 1:2, Then each list contributes w/(k0+rank) and the heavier list's top doc wins", () => {
    const lists = [
      ["lex-top", "shared"],
      ["sem-top", "shared"],
    ];
    // Unweighted: lex-top and sem-top tie, first appearance (lex) wins.
    expect(rrfFuse(lists)[1].id).toBe("lex-top");
    const fused = rrfFuse(lists, RRF_K, [1, 2]);
    expect(fused.map((f) => f.id)).toEqual(["shared", "sem-top", "lex-top"]);
    expect(fused.find((f) => f.id === "sem-top")!.score).toBeCloseTo(2 / 61, 12);
    expect(fused.find((f) => f.id === "shared")!.score).toBeCloseTo(1 / 62 + 2 / 62, 12);
  });

  it("config search.fusion_weights reaches hybrid context_search", async () => {
    const { ctx, dir } = await makeVault(
      "search:\n  fusion_weights: { lexical: 0, semantic: 1 }\n  embeddings:\n    provider: stub\n    model: concepts-v1\n",
    );
    try {
      await api.run("context_create", { id: "nodes/kw", title: "Keyword", content: "zebra zebra zebra" }, ctx);
      await api.run("context_create", { id: "nodes/para", title: "Para", content: "furious client complaint" }, ctx);
      await api.run("context_embed", {}, ctx);
      // lexical weight 0: the keyword-only hit gets rrf 0 from lexical, the
      // semantic neighbour leads.
      const out = await api.run<SearchOut>("context_search", { query: "zebra upset", mode: "hybrid" }, ctx);
      expect(out.results[0].id).toBe("nodes/para");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ties break deterministically by first appearance", () => {
    expect(rrfFuse([["x"], ["y"]]).map((f) => f.id)).toEqual(["x", "y"]);
  });
});

// ─── 3. Embeddings: published only, versioned, invalidated ──────────────────

describe("context_embed — governed embedding index", () => {
  let ctx: OperationContext;
  let dir: string;

  beforeEach(async () => {
    embedCalls = [];
    rerankCalls = 0;
    ({ ctx, dir } = await makeVault());
    await api.run("context_create", {
      id: "nodes/escalation", title: "Escalation policy", content: "When a client is furious, open a complaint ticket.",
    }, ctx);
    await api.run("context_create", {
      id: "nodes/refunds", title: "Refunds", content: "Reimbursement rules: money goes back within 5 days.",
    }, ctx);
    await api.run("context_create", {
      id: "nodes/release", title: "Release train", content: "We ship a deployment every Tuesday.",
    }, ctx);
    await api.run("context_create", {
      id: "nodes/secret-draft", title: "Draft", content: "angry customer refund secret plan", publish: false,
    }, ctx);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("Given a draft, When embedding, Then only published documents are sent to the provider", async () => {
    const out = await api.run<{ embedded: number; total: number }>("context_embed", {}, ctx);
    expect(out.embedded).toBe(3);
    expect(out.total).toBe(3);
    const sent = embedCalls.flat().join("\n");
    expect(sent).not.toContain("secret plan");
  });

  it("stores the index under .context/embeddings with a self-ignoring .gitignore", async () => {
    await api.run("context_embed", {}, ctx);
    expect(EMBEDDINGS_DIR).toBe(".context/embeddings");
    const gi = await readFile(join(dir, EMBEDDINGS_DIR, ".gitignore"), "utf-8");
    expect(gi.trim()).toBe("*");
    await stat(join(dir, EMBEDDINGS_DIR, "stub--concepts-v1.json"));
    await stat(join(dir, EMBEDDINGS_DIR, "stub--concepts-v1.f32"));
  });

  it("Given an unchanged vault, When embedding again, Then nothing is re-embedded", async () => {
    await api.run("context_embed", {}, ctx);
    embedCalls = [];
    const out = await api.run<{ embedded: number; reused: number }>("context_embed", {}, ctx);
    expect(out).toMatchObject({ embedded: 0, reused: 3 });
    expect(embedCalls).toHaveLength(0);
  });

  it("Given a new published version, When embedding, Then only that doc is re-embedded", async () => {
    await api.run("context_embed", {}, ctx);
    await api.run("context_update", { id: "nodes/refunds", content: "Reimbursement rules changed: money back in 10 days." }, ctx);
    embedCalls = [];
    const out = await api.run<{ embedded: number; reused: number }>("context_embed", {}, ctx);
    expect(out).toMatchObject({ embedded: 1, reused: 2 });
    expect(embedCalls.flat().join(" ")).toContain("10 days");
  });

  it("Given a stale vector (doc changed, not re-embedded), Then semantic search skips it rather than serve the old version", async () => {
    await api.run("context_embed", {}, ctx);
    await api.run("context_update", { id: "nodes/refunds", content: "Nothing about that topic any more." }, ctx);
    const out = await api.run<SearchOut & { embeddings_stale?: number }>(
      "context_search", { query: "reimbursement money", mode: "semantic" }, ctx,
    );
    expect(out.results.map((r) => r.id)).not.toContain("nodes/refunds");
    expect(out.embeddings_stale).toBe(1);
  });

  it("Given a doc that went back to draft, When embedding, Then its vector is pruned", async () => {
    await api.run("context_embed", {}, ctx);
    await api.run("context_update", { id: "nodes/release", status: "draft" }, ctx);
    const out = await api.run<{ pruned: number; total: number }>("context_embed", {}, ctx);
    expect(out).toMatchObject({ pruned: 1, total: 2 });
  });

  it("Given a paraphrase with no shared words, When searching semantic, Then the right doc is first", async () => {
    await api.run("context_embed", {}, ctx);
    const lexical = await api.run<SearchOut>("context_search", { query: "upset buyers" }, ctx);
    expect(lexical.results).toHaveLength(0);
    const out = await api.run<SearchOut>("context_search", { query: "upset buyers", mode: "semantic" }, ctx);
    expect(out.mode).toBe("semantic");
    expect(out.results[0].id).toBe("nodes/escalation");
    expect(typeof out.results[0].scores?.semantic).toBe("number");
    expect(out.results.map((r) => r.id)).not.toContain("nodes/secret-draft");
  });

  it("hybrid fuses lexical and semantic with RRF and keeps per-hit scores", async () => {
    await api.run("context_embed", {}, ctx);
    const out = await api.run<SearchOut>("context_search", { query: "furious deployment", mode: "hybrid" }, ctx);
    expect(out.mode).toBe("hybrid");
    const ids = out.results.map((r) => r.id);
    expect(ids).toContain("nodes/escalation");
    expect(ids).toContain("nodes/release");
    for (const r of out.results) {
      expect(typeof r.scores?.rrf).toBe("number");
      expect(r.score).toBe(r.scores!.rrf);
    }
    // Default weights 1:2: every rrf is Σ w/(61+i) with w ∈ {1, 2}.
    const top = out.results[0].scores!;
    const expected = (top.lexical !== undefined ? 1 : 0) + (top.semantic !== undefined ? 2 : 0);
    expect(top.rrf! * 61).toBeLessThanOrEqual(expected + 1e-9);
    expect(top.rrf! * 61).toBeGreaterThan(0);
  });

  it("hybrid keeps an exact title match as a deterministic top seed", async () => {
    await api.run("context_embed", {}, ctx);
    const out = await api.run<SearchOut>("context_search", { query: "Release train", mode: "hybrid" }, ctx);
    expect(out.results[0].id).toBe("nodes/release");
  });

  it("hybrid keeps an exact #tag match as a seed", async () => {
    await api.run("context_create", {
      id: "nodes/oncall", title: "Pager rota", content: "zzz", tags: ["#oncall"],
    }, ctx);
    await api.run("context_embed", {}, ctx);
    const out = await api.run<SearchOut>("context_search", { query: "#oncall furious client", mode: "hybrid" }, ctx);
    expect(out.results[0].id).toBe("nodes/oncall");
  });

  it("rerank reorders the fused top-N", async () => {
    await api.run("context_embed", {}, ctx);
    const plain = await api.run<SearchOut>("context_search", { query: "furious client refund", mode: "semantic" }, ctx);
    const reranked = await api.run<SearchOut>(
      "context_search", { query: "furious client refund", mode: "semantic", rerank: true }, ctx,
    );
    expect(rerankCalls).toBe(1);
    expect(reranked.results.map((r) => r.id)).toEqual([...plain.results.map((r) => r.id)].reverse());
    expect(typeof reranked.results[0].scores?.rerank).toBe("number");
  });

  it("default mode stays lexical even when an index exists, unless config opts in", async () => {
    await api.run("context_embed", {}, ctx);
    const out = await api.run<SearchOut>("context_search", { query: "refund" }, ctx);
    expect(out.mode).toBe("lexical");
  });

  it("config search.mode: hybrid is honoured once embeddings exist, and falls back to lexical before", async () => {
    await writeFile(
      join(dir, ".context", "config.yaml"),
      `version: 1\nname: test\nsearch:\n  mode: hybrid\n  embeddings:\n    provider: stub\n    model: concepts-v1\n`,
    );
    const before = await api.run<SearchOut>("context_search", { query: "refund" }, ctx);
    expect(before.mode).toBe("lexical");
    await api.run("context_embed", {}, ctx);
    const after = await api.run<SearchOut>("context_search", { query: "refund" }, ctx);
    expect(after.mode).toBe("hybrid");
  });

  it("an explicit semantic request with no index built fails with a pointer to ctx embed", async () => {
    await expect(
      api.run("context_search", { query: "refund", mode: "semantic" }, ctx),
    ).rejects.toThrow(/ctx embed|context_embed/);
  });

  it("an explicit semantic request with no embeddings config fails clearly", async () => {
    const v = await makeVault("");
    try {
      await expect(
        api.run("context_search", { query: "refund", mode: "semantic" }, v.ctx),
      ).rejects.toThrow(/search\.embeddings/);
    } finally {
      await rm(v.dir, { recursive: true, force: true });
    }
  });
});

// ─── 4. Bedrock request shaping (transport stubbed) ─────────────────────────

describe("Bedrock providers — request shape", () => {
  it("Cohere Embed v4 sends input_type per side and reads embeddings.float", async () => {
    const bodies: Array<{ model: string; body: any }> = [];
    const p = createBedrockEmbeddingProvider(
      { provider: "bedrock", model: "cohere.embed-v4:0", region: "us-east-1" },
      async (model, body) => {
        bodies.push({ model, body });
        return { embeddings: { float: (body.texts as string[]).map(() => [1, 0]) } };
      },
    );
    expect(await p.embed(["a", "b"], "document")).toEqual([[1, 0], [1, 0]]);
    await p.embed(["q"], "query");
    expect(bodies[0]).toMatchObject({ model: "cohere.embed-v4:0", body: { texts: ["a", "b"], input_type: "search_document", embedding_types: ["float"] } });
    expect(bodies[1].body.input_type).toBe("search_query");
  });

  it("Titan v2 embeds one text per call and reads `embedding`", async () => {
    const seen: any[] = [];
    const p = createBedrockEmbeddingProvider(
      { provider: "bedrock", model: "amazon.titan-embed-text-v2:0", dimensions: 256 },
      async (_m, body) => {
        seen.push(body);
        return { embedding: [0.5, 0.5] };
      },
    );
    expect(await p.embed(["x", "y"], "document")).toHaveLength(2);
    expect(seen).toEqual([
      { inputText: "x", dimensions: 256, normalize: true },
      { inputText: "y", dimensions: 256, normalize: true },
    ]);
  });

  it("Cohere Rerank 3.5 sends api_version 2 and maps relevance_score", async () => {
    let sent: any;
    const r = createBedrockReranker(
      { provider: "bedrock", model: "cohere.rerank-v3-5:0" },
      async (_m, body) => {
        sent = body;
        return { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] };
      },
    );
    expect(await r.rerank("q", ["d0", "d1"], 2)).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
    expect(sent).toEqual({ query: "q", documents: ["d0", "d1"], top_n: 2, api_version: 2 });
  });
});

// ─── 5. Throttling: retry with backoff (Bedrock quotas are per MINUTE) ──────

describe("Bedrock retry on throttling", () => {
  function throttle(name = "ThrottlingException", extra: Record<string, unknown> = {}) {
    return Object.assign(new Error("Rate exceeded"), { name, $metadata: { httpStatusCode: 429 }, ...extra });
  }

  it("Given ThrottlingException twice, When reranking, Then it backs off and succeeds on the third attempt", async () => {
    const waits: number[] = [];
    let calls = 0;
    const r = createBedrockReranker(
      { provider: "bedrock", model: "cohere.rerank-v3-5:0" },
      async () => {
        calls++;
        if (calls <= 2) throw throttle();
        return { results: [{ index: 0, relevance_score: 0.7 }] };
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 1 },
    );
    expect(await r.rerank("q", ["d0"], 1)).toEqual([{ index: 0, score: 0.7 }]);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]); // exponential, full jitter at random()=1
  });

  it("embedding retries an HTTP 429 and honours Retry-After", async () => {
    const waits: number[] = [];
    let calls = 0;
    const p = createBedrockEmbeddingProvider(
      { provider: "bedrock", model: "cohere.embed-v4:0" },
      async (_m, body) => {
        if (++calls === 1) throw new BedrockHttpError("HTTP 429", 429, 7000);
        return { embeddings: { float: (body.texts as string[]).map(() => [1]) } };
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 0 },
    );
    expect(await p.embed(["a"], "document")).toEqual([[1]]);
    expect(waits).toEqual([7000]);
  });

  it("caps each wait and gives up after the attempt limit, rethrowing the throttle", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      withBedrockRetry(
        async () => {
          calls++;
          throw throttle("TooManyRequestsException");
        },
        { attempts: 8, capMs: 60_000, sleep: async (ms) => void waits.push(ms), random: () => 1 },
      ),
    ).rejects.toThrow(/Rate exceeded/);
    expect(calls).toBe(8);
    expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
    expect(waits.at(-1)).toBe(60_000);
  });

  it("does not retry a non-transient error (e.g. ValidationException)", async () => {
    let calls = 0;
    await expect(
      withBedrockRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("bad input"), { name: "ValidationException", $metadata: { httpStatusCode: 400 } });
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/bad input/);
    expect(calls).toBe(1);
  });

  it("retries ServiceUnavailableException", async () => {
    let calls = 0;
    const out = await withBedrockRetry(
      async () => {
        if (++calls < 3) throw throttle("ServiceUnavailableException", { $metadata: { httpStatusCode: 503 } });
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(out).toBe("ok");
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

// ─── 6. Transport errors and request size (first real-scale run) ────────────

describe("transient transport errors are retried", () => {
  const cases: Array<[string, unknown]> = [
    ["smithy canceled stream", new Error("The pending stream has been canceled (caused by: socket hang up)")],
    ["TimeoutError", Object.assign(new Error("Request timed out"), { name: "TimeoutError" })],
    ["ECONNRESET code", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["undici fetch terminated", new TypeError("terminated")],
    ["fetch failed with ETIMEDOUT cause", Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })],
    ["EPIPE", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })],
  ];

  it.each(cases)("%s is transient", (_label, err) => {
    expect(isTransientTransportError(err)).toBe(true);
  });

  it("a plain validation error is not transient", () => {
    expect(isTransientTransportError(new Error("Malformed input request"))).toBe(false);
  });

  it("Given 'pending stream has been canceled' on the first call, When embedding, Then it backs off and succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const p = createBedrockEmbeddingProvider(
      { provider: "bedrock", model: "cohere.embed-v4:0" },
      async (_m, body) => {
        if (++calls === 1) throw new Error("The pending stream has been canceled");
        return { embeddings: { float: (body.texts as string[]).map(() => [1]) } };
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 1 },
    );
    expect(await p.embed(["a", "b"], "document")).toEqual([[1], [1]]);
    expect(calls).toBe(2);
    expect(waits).toEqual([1000]);
  });
});

describe("embedding requests are capped by total characters", () => {
  it("requestBatches splits on item count and on total characters", () => {
    const texts = ["x".repeat(60), "x".repeat(60), "x".repeat(60), "x".repeat(10)];
    expect(requestBatches(texts, 32, 100)).toEqual([[0, 1], [1, 2], [2, 4]]);
    expect(requestBatches(texts, 2, 1_000)).toEqual([[0, 2], [2, 4]]);
    // An over-long single text still goes, alone.
    expect(requestBatches(["x".repeat(500)], 32, 100)).toEqual([[0, 1]]);
  });

  it("Cohere sends no request over max_request_chars", async () => {
    const sizes: number[] = [];
    const p = createBedrockEmbeddingProvider(
      { provider: "bedrock", model: "cohere.embed-v4:0", max_request_chars: 250 },
      async (_m, body) => {
        const t = body.texts as string[];
        sizes.push(t.reduce((n, x) => n + x.length, 0));
        return { embeddings: { float: t.map(() => [1]) } };
      },
    );
    const out = await p.embed(Array.from({ length: 10 }, () => "y".repeat(100)), "document");
    expect(out).toHaveLength(10);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(250);
    expect(sizes).toHaveLength(5);
  });

  it("context_embed splits batch_size batches that exceed max_request_chars", async () => {
    embedCalls = [];
    const { ctx, dir } = await makeVault(
      "search:\n  embeddings:\n    provider: stub\n    model: concepts-v1\n    batch_size: 32\n    max_request_chars: 300\n",
    );
    try {
      for (let i = 0; i < 4; i++) {
        await api.run("context_create", { id: `nodes/long-${i}`, title: `Long ${i}`, content: "refund ".repeat(30) }, ctx);
      }
      const out = await api.run<{ embedded: number }>("context_embed", {}, ctx);
      expect(out.embedded).toBe(4);
      for (const call of embedCalls) expect(call.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(300);
      expect(embedCalls.length).toBeGreaterThan(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── 7. Passage-level rerank ─────────────────────────────────────────────────

describe("rerank on passages, not whole documents", () => {
  const QUERY = "adrenal tumor surgery outcomes";
  const words = QUERY.split(" ");
  /** Stub cross-encoder: query-word hits, diluted by passage length (as real ones are by off-topic text). */
  function dilutingReranker(log: string[][] = []): Reranker {
    return {
      name: "stub",
      model: "dilute",
      async rerank(_q, documents, topN) {
        log.push(documents);
        return documents
          .map((d, index) => {
            const lower = d.toLowerCase();
            const hits = words.filter((w) => lower.includes(w)).length;
            return { index, score: hits / (1 + d.length / 1000) };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, topN);
      },
    };
  }
  const filler = Array.from({ length: 18 }, (_, i) =>
    `Paragraph ${i}: quarterly logistics, staffing rotas, cafeteria menus, parking and travel policy notes for the regional office.`.repeat(3),
  ).join("\n\n");
  const deep = "The adrenal tumor surgery cohort showed strong outcomes: complication rates fell by half after laparoscopic resection.";
  const longDoc = node("nodes/long-report", `${filler}\n\n${deep}\n\n${filler}`);
  const shortDoc = node("nodes/short-note", "Surgery scheduling for the clinic is on Tuesdays.");
  const asHits = (docs: any[]): RankedHit[] => docs.map((d, i) => ({ document: d, score: 1 - i / 10, scores: {} }));

  it("splitPassages makes ~300-token, paragraph-aware windows that cover the text", () => {
    const windows = splitPassages(longDoc.body);
    expect(windows.length).toBeGreaterThan(5);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(1200);
    expect(windows.some((w) => w.includes(deep))).toBe(true);
  });

  it("Given a long doc with the answer deep inside, When reranking by passage, Then it outranks a short loosely-related doc and returns that passage", async () => {
    const out = await rerankHits(QUERY, asHits([shortDoc, longDoc]), dilutingReranker());
    expect(out[0].document.id).toBe("nodes/long-report");
    expect(out[0].passage).toContain(deep);
    expect(typeof out[0].scores.rerank).toBe("number");
  });

  it("Given unit: document, Then the same long doc is diluted and loses (the gap passage rerank closes)", async () => {
    const out = await rerankHits(QUERY, asHits([shortDoc, longDoc]), dilutingReranker(), { unit: "document" });
    expect(out[0].document.id).toBe("nodes/short-note");
    expect(out[0].passage).toBeUndefined();
  });

  it("defaults: 100 candidates × ~10 windows each → ONE rerank call of 100 passages", async () => {
    expect(DEFAULT_RERANK_TOP_N).toBe(100);
    // 100 candidates of ~2.6k tokens (~10.4k chars) each.
    const para = "Market news paragraph with figures, quotes and context about the companies involved in the deal. ".repeat(4);
    const docs = Array.from({ length: 100 }, (_, i) =>
      node(`nodes/news-${i}`, Array.from({ length: 26 }, () => para).join("\n\n").slice(0, 10_400)),
    );
    expect(splitPassages(docs[0].body).length).toBeGreaterThanOrEqual(9);
    const log: string[][] = [];
    const out = await rerankHits("deal figures", asHits(docs), dilutingReranker(log));
    expect(log).toHaveLength(1);
    expect(log[0]).toHaveLength(100);
    expect(out.every((h) => typeof h.passage === "string")).toBe(true);
  });

  it("the window sent is chosen locally by stemmed BM25 (the deep relevant paragraph, not the first)", () => {
    const [pick] = selectPassages(QUERY, asHits([longDoc]), 100);
    expect(pick.passage).toContain(deep);
  });

  it("ties go to the earlier window", () => {
    const body = ["alpha one.", "x".repeat(1150), "alpha two."].join("\n\n");
    const [pick] = selectPassages("zzz-no-match", asHits([node("nodes/t", body)]), 100);
    expect(pick.passage.startsWith("alpha one.")).toBe(true);
  });

  it("Given max_passages > top_n, Then extra windows are spread round-robin by local score", () => {
    const a = node("nodes/a", [`adrenal surgery ${"a ".repeat(500)}`, `adrenal ${"b ".repeat(500)}`, "zzz ".repeat(250)].join("\n\n"));
    const b = node("nodes/b", [`adrenal surgery outcomes ${"c ".repeat(500)}`, "yyy ".repeat(250)].join("\n\n"));
    const picks = selectPassages(QUERY, asHits([a, b]), 3);
    expect(picks.map((p) => p.doc)).toEqual([0, 1, 0]); // round 1: one each; round 2: a's next-best
    const budget2 = selectPassages(QUERY, asHits([a, b]), 2);
    expect(budget2.map((p) => p.doc)).toEqual([0, 1]);
  });

  it("context_search --json carries the best passage per hit", async () => {
    const { ctx, dir } = await makeVault(
      "search:\n  embeddings:\n    provider: stub\n    model: concepts-v1\n  rerank:\n    provider: dilute\n    model: d\n",
    );
    registerReranker("dilute", () => dilutingReranker());
    try {
      await api.run("context_create", { id: "nodes/long-report", title: "Ops report", content: longDoc.body }, ctx);
      await api.run("context_create", { id: "nodes/short-note", title: "Clinic note", content: shortDoc.body }, ctx);
      const out = await api.run<{ results: Array<Hit & { passage?: string }> }>(
        "context_search", { query: "surgery outcomes", rerank: true }, ctx,
      );
      expect(out.results[0].id).toBe("nodes/long-report");
      expect(out.results[0].passage).toContain(deep);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
