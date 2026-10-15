/**
 * Semantic and hybrid ranking over the governed embedding index.
 *
 * Hybrid = reciprocal rank fusion (k0 = 60) of the lexical list and the vector
 * list, with DETERMINISTIC SEEDS pinned on top: documents whose title equals
 * the query, or that carry a `#tag` written in the query (or a tag equal to
 * the whole query). Seeds are the exact matches a selector would return; the
 * workflow plane's replay guarantee depends on recorded reads being
 * reproducible, so an exact match must never be pushed down by a vector
 * neighbour (spec nodes/dev/spec-retrieval-modes, 2026-09-08 reframe).
 */
import type { ContextNode } from "../types.js";
import { Resolver, exactSeeds, processSearchTerm, type FieldBoosts } from "../resolver.js";

export { exactSeeds };
import type { EmbeddingProvider, Reranker } from "./providers.js";
import { requestBatches, DEFAULT_MAX_REQUEST_CHARS } from "./bedrock.js";
import MiniSearch from "minisearch";
import { splitPassages } from "./passages.js";
import { EmbeddingStore, embeddable, embeddingText, keyFor, normalize, DEFAULT_MAX_CHARS } from "./embedding-store.js";

export const RRF_K = 60;
export const DEFAULT_CANDIDATES = 100;
export const DEFAULT_RERANK_TOP_N = 100;

/**
 * Default hybrid RRF weights: semantic counts double. Chosen on a dev-set
 * sweep (1:1, 1:1.5, 1:2, 1:3) over BEIR SciFact + NFCorpus with bge-base
 * dense: SciFact NDCG@10 1:1 0.726 → 1:2 0.747 (dense alone 0.740); NFCorpus
 * 1:1 = 1:2 = 0.370, with 1:2 best Recall@100. Held-out sets were not used.
 * Override with `search.fusion_weights`.
 */
export const DEFAULT_FUSION_WEIGHTS: Readonly<{ lexical: number; semantic: number }> = Object.freeze({
  lexical: 1,
  semantic: 2,
});

export interface HitScores {
  lexical?: number;
  semantic?: number;
  rrf?: number;
  rerank?: number;
}

export interface RankedHit {
  document: ContextNode;
  /** The score the list is ordered by (mode-dependent). */
  score: number;
  scores: HitScores;
  /** True for an exact title/tag seed. */
  seed?: boolean;
  /** Passage rerank: the best-matching ~300-token window of this document. */
  passage?: string;
}

/**
 * Weighted reciprocal rank fusion: score(d) = Σ w_i / (k + rank_i(d)), rank
 * 1-based, w_i = weights[i] (default 1 — plain RRF). Ties keep
 * first-appearance order (list 0 before list 1), so fusion is deterministic
 * for identical inputs.
 */
export function rrfFuse(
  lists: string[][],
  k = RRF_K,
  weights: number[] = [],
): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + w / (k + i + 1)));
  });
  // Map iteration order = first appearance; Array.sort is stable.
  return [...score.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}

export interface SemanticSearchOptions {
  mode: "semantic" | "hybrid";
  docs: ContextNode[];
  store: EmbeddingStore;
  provider: EmbeddingProvider;
  candidates?: number;
  fullMatchFirst?: boolean;
  fieldBoosts?: Partial<FieldBoosts>;
  coordination?: boolean;
  /** Hybrid RRF weights per list (default DEFAULT_FUSION_WEIGHTS, 1:2). */
  fusionWeights?: { lexical?: number; semantic?: number };
  maxChars?: number;
  reranker?: Reranker;
  rerankTopN?: number;
  rerank?: Omit<RerankOptions, "topN" | "maxChars">;
}

export interface SemanticSearchResult {
  hits: RankedHit[];
  /** Published documents whose stored vector is missing or out of date. */
  stale: number;
}

/** Brute-force cosine over unit vectors; fine to ~100k docs in-process. */
function vectorRank(
  queryVec: Float32Array,
  docs: ContextNode[],
  store: EmbeddingStore,
  maxChars: number,
): { ranked: Array<{ id: string; score: number }>; stale: number } {
  let stale = 0;
  const ranked: Array<{ id: string; score: number }> = [];
  for (const d of docs) {
    const v = store.vectorFor(keyFor(d, maxChars));
    if (!v) {
      stale++;
      continue;
    }
    if (v.length !== queryVec.length) {
      throw new Error(
        `query embedding has ${queryVec.length} dimensions, the index has ${v.length} — check search.embeddings.dimensions or run ctx embed --rebuild`,
      );
    }
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
    ranked.push({ id: d.id, score: dot });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, stale };
}

export async function semanticSearch(query: string, opts: SemanticSearchOptions): Promise<SemanticSearchResult> {
  const q = query.trim();
  if (!q) return { hits: [], stale: 0 };
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const candidates = opts.candidates ?? DEFAULT_CANDIDATES;
  const published = embeddable(opts.docs);
  const byId = new Map(published.map((d) => [d.id, d]));

  const [qv] = await opts.provider.embed([q], "query");
  const { ranked: vec, stale } = vectorRank(normalize(qv), published, opts.store, maxChars);
  const vecTop = vec.slice(0, candidates);
  const semScore = new Map(vecTop.map((h) => [h.id, h.score]));

  let hits: RankedHit[];
  if (opts.mode === "semantic") {
    // Seeds first, as in hybrid (by similarity; one with no current vector
    // last), then the rest of the vector list.
    const seedSet = new Set(exactSeeds(q, published));
    const semAll = new Map(vec.map((h) => [h.id, h.score]));
    const seedOrder = [...seedSet].sort((a, b) => (semAll.get(b) ?? -2) - (semAll.get(a) ?? -2));
    const order = [...seedOrder, ...vecTop.map((h) => h.id).filter((id) => !seedSet.has(id))];
    hits = order.map((id) => {
      const s = semAll.get(id);
      return {
        document: byId.get(id)!,
        score: s ?? 0,
        scores: s === undefined ? {} : { semantic: s },
        ...(seedSet.has(id) ? { seed: true } : {}),
      };
    });
  } else {
    const lexical = new Resolver({
      documents: published,
      fullMatchFirst: opts.fullMatchFirst,
      fieldBoosts: opts.fieldBoosts,
      coordination: opts.coordination,
      minRelativeScore: 0,
    })
      .search(q)
      .slice(0, candidates);
    const lexScore = new Map(lexical.map((h) => [h.document.id, h.score]));
    const fused = rrfFuse([lexical.map((h) => h.document.id), vecTop.map((h) => h.id)], RRF_K, [
      opts.fusionWeights?.lexical ?? DEFAULT_FUSION_WEIGHTS.lexical,
      opts.fusionWeights?.semantic ?? DEFAULT_FUSION_WEIGHTS.semantic,
    ]);
    const seeds = exactSeeds(q, published);
    const seedSet = new Set(seeds);
    const fusedScore = new Map(fused.map((f) => [f.id, f.score]));
    // Seeds first (in fused order where present, else lexical/vault order),
    // then the rest of the fused list.
    const seedOrder = [...seeds].sort(
      (a, b) => (fusedScore.get(b) ?? 0) - (fusedScore.get(a) ?? 0),
    );
    const order = [...seedOrder, ...fused.map((f) => f.id).filter((id) => !seedSet.has(id))];
    hits = order.map((id) => {
      const scores: HitScores = { rrf: fusedScore.get(id) ?? 0 };
      if (lexScore.has(id)) scores.lexical = lexScore.get(id);
      if (semScore.has(id)) scores.semantic = semScore.get(id);
      return { document: byId.get(id)!, score: scores.rrf!, scores, ...(seedSet.has(id) ? { seed: true } : {}) };
    });
  }

  if (opts.reranker) {
    hits = await rerankHits(q, hits, opts.reranker, { ...opts.rerank, topN: opts.rerankTopN, maxChars });
  }
  return { hits, stale };
}

export type RerankUnit = "passage" | "document";
export const DEFAULT_MAX_PASSAGES = 100;
export const DEFAULT_RERANK_BATCH = 100;

export interface RerankOptions {
  /** Non-seed hits to rerank (default DEFAULT_RERANK_TOP_N = 100). */
  topN?: number;
  /** passage (default): rerank ~300-token windows, doc score = best window. document: whole docs. */
  unit?: RerankUnit;
  /** Per-document text cap before splitting (the embedding max_chars). */
  maxChars?: number;
  /** Max windows sent per query, across all documents (default 100 = one request). */
  maxPassages?: number;
  /** Max sources per reranker request (default 100). */
  batchSize?: number;
  passageChars?: number;
}

/**
 * Pick which windows go to the reranker — locally, no API call. Every
 * candidate is split into ~300-token windows, and the windows are scored
 * against the query with the same stemmed BM25 the lexical search uses
 * (an index over the windows themselves; ties go to the earlier window).
 * Round 1 gives each document its single best window; only when the budget
 * exceeds the document count do later rounds add each document's next-best
 * window, highest local score first. Default budget = 100 = one rerank
 * request per query, the same budget as Bedrock KB's reranker.
 */
export function selectPassages(
  query: string,
  head: RankedHit[],
  budget: number,
  maxChars = DEFAULT_MAX_CHARS,
  passageChars?: number,
): Array<{ doc: number; text: string; passage: string }> {
  const perDoc = head.map((h) => {
    const title = String(h.document.frontmatter.title ?? "").trim();
    const body = [h.document.frontmatter.description ?? "", h.document.body ?? ""]
      .filter((p) => p && p.trim())
      .join("\n\n")
      .slice(0, maxChars);
    const windows = splitPassages(body, passageChars);
    return { title, windows: windows.length ? windows : [""] };
  });

  const index = new MiniSearch<{ id: string; text: string }>({
    fields: ["text"],
    idField: "id",
    processTerm: processSearchTerm,
  });
  index.addAll(perDoc.flatMap((d, i) => d.windows.map((w, j) => ({ id: `${i}:${j}`, text: `${d.title}\n${w}` }))));
  const local = new Map<string, number>();
  for (const r of index.search(query)) local.set(r.id as string, r.score);

  // Each doc's windows, best local score first (earlier window on ties).
  const ranked = perDoc.map((d, i) =>
    d.windows
      .map((w, j) => ({ j, w, s: local.get(`${i}:${j}`) ?? 0 }))
      .sort((a, b) => b.s - a.s || a.j - b.j),
  );
  const out: Array<{ doc: number; text: string; passage: string; s: number }> = [];
  for (let round = 0; out.length < budget; round++) {
    const picks = ranked
      .map((wins, i) => ({ i, pick: wins[round] }))
      .filter((x) => x.pick !== undefined);
    if (picks.length === 0) break;
    // Round 1 keeps candidate order (the fused ranking decides who fits a
    // short budget); later rounds go by local window score.
    if (round > 0) picks.sort((a, b) => b.pick.s - a.pick.s || a.i - b.i);
    for (const { i, pick } of picks) {
      if (out.length >= budget) break;
      const title = perDoc[i].title;
      out.push({ doc: i, text: title ? `${title}\n\n${pick.w}` : pick.w, passage: pick.w, s: pick.s });
    }
  }
  return out.map(({ doc, text, passage }) => ({ doc, text, passage }));
}

/**
 * Rerank the top-N non-seed hits; seeds stay pinned (determinism), and hits
 * below N keep their order after the reranked block.
 *
 * Passage unit (default): each candidate contributes its locally best
 * ~300-token window (selectPassages — BM25 over the windows, no API call);
 * the windows go to the reranker in requests of ≤ `batchSize`, and a
 * document scores as its best window, returned as `passage`. With the
 * defaults (top_n 100, max_passages 100, batch_size 100) that is ONE
 * rerank request per query. max_passages > top_n adds next-best windows.
 */
export async function rerankHits(
  query: string,
  hits: RankedHit[],
  reranker: Reranker,
  opts: RerankOptions = {},
): Promise<RankedHit[]> {
  const topN = opts.topN ?? DEFAULT_RERANK_TOP_N;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const batchSize = opts.batchSize ?? DEFAULT_RERANK_BATCH;
  const seeds = hits.filter((h) => h.seed);
  const rest = hits.filter((h) => !h.seed);
  const head = rest.slice(0, topN);
  const tail = rest.slice(topN);
  if (head.length === 0) return hits;

  // Sources: one per document, or the locally best window(s) of each.
  const sources: Array<{ doc: number; text: string; passage?: string }> = [];
  if ((opts.unit ?? "passage") === "document") {
    head.forEach((h, i) => sources.push({ doc: i, text: embeddingText(h.document, maxChars) }));
  } else {
    sources.push(...selectPassages(query, head, opts.maxPassages ?? DEFAULT_MAX_PASSAGES, maxChars, opts.passageChars));
  }

  const best = new Map<number, { score: number; passage?: string }>();
  for (let start = 0; start < sources.length; start += batchSize) {
    const batch = sources.slice(start, start + batchSize);
    const results = await reranker.rerank(query, batch.map((s) => s.text), batch.length);
    for (const r of results) {
      const src = batch[r.index];
      if (!src) continue;
      const prev = best.get(src.doc);
      if (!prev || r.score > prev.score) best.set(src.doc, { score: r.score, passage: src.passage });
    }
  }

  const scored = head
    .map((h, i) => ({ h, i, b: best.get(i) }))
    .filter((x) => x.b !== undefined)
    .sort((a, b) => b.b!.score - a.b!.score || a.i - b.i);
  const reranked: RankedHit[] = scored.map(({ h, b }) => ({
    ...h,
    score: b!.score,
    scores: { ...h.scores, rerank: b!.score },
    ...(b!.passage !== undefined ? { passage: b!.passage } : {}),
  }));
  // Anything the reranker dropped keeps its fused order after the reranked block.
  head.forEach((h, i) => {
    if (!best.has(i)) reranked.push(h);
  });
  return [...seeds, ...reranked, ...tail];
}

export interface BuildResult {
  provider: string;
  model: string;
  path: string;
  total: number;
  embedded: number;
  reused: number;
  pruned: number;
  dimensions: number;
}

/**
 * Bring the index in line with the vault's published documents: embed new or
 * changed ones, keep unchanged vectors, prune everything else. `rebuild`
 * discards the whole index first. Saves after every `saveEvery` batches so an
 * interrupted run on a large corpus resumes where it stopped.
 */
export async function buildEmbeddings(
  docs: ContextNode[],
  store: EmbeddingStore,
  provider: EmbeddingProvider,
  opts: {
    rebuild?: boolean;
    batchSize?: number;
    maxChars?: number;
    /** Total characters per provider call; batches are split to fit (default 200k). */
    maxRequestChars?: number;
    saveEvery?: number;
    /** Persist the store (default `store.save()`); context_embed saves under the vault lock. */
    save?: () => Promise<void>;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<BuildResult> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const batchSize = opts.batchSize ?? 32;
  const saveEvery = opts.saveEvery ?? 20;
  const save = opts.save ?? (() => store.save());
  if (opts.rebuild) store.clear();

  const published = embeddable(docs);
  const live = new Set(published.map((d) => d.id));
  let pruned = 0;
  for (const id of store.ids()) {
    if (!live.has(id)) {
      store.delete(id);
      pruned++;
    }
  }

  const todo: Array<{ doc: ContextNode; key: ReturnType<typeof keyFor> }> = [];
  let reused = 0;
  for (const doc of published) {
    const key = keyFor(doc, maxChars);
    if (store.vectorFor(key)) reused++;
    else todo.push({ doc, key });
  }
  // A changed document's old vector is stale; prune counts only removed docs.
  for (const { key } of todo) store.delete(key.id);

  let done = 0;
  let batches = 0;
  const texts = todo.map((t) => embeddingText(t.doc, maxChars));
  for (const [a, b] of requestBatches(texts, batchSize, opts.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS)) {
    const batch = todo.slice(a, b);
    const vectors = await provider.embed(texts.slice(a, b), "document");
    if (vectors.length !== batch.length) {
      throw new Error(`provider returned ${vectors.length} vectors for ${batch.length} documents`);
    }
    batch.forEach((t, j) => store.set(t.key, vectors[j]));
    done += batch.length;
    opts.onProgress?.(done, todo.length);
    if (++batches % saveEvery === 0) await save();
  }
  await save();
  return {
    provider: store.provider,
    model: store.model,
    path: store.relativePath,
    total: store.size,
    embedded: todo.length,
    reused,
    pruned,
    dimensions: store.dimensions,
  };
}
