# Retrieval modes: lexical, semantic, hybrid

`ctx search` / `context_search` run in one of three modes:

| Mode | What ranks | Needs |
| --- | --- | --- |
| `lexical` (default) | BM25 over title/description/body/tags, English-stemmed (Porter) at index and query time, stopwords dropped. Scores are the plain BM25 sum over matched terms (no coordination factor, `search.coordination`). Field boosts are all 1 by default (`search.field_boosts`). Documents matching every term are pinned first unless `search.full_match_first: false`. | nothing |
| `semantic` | Cosine similarity between the query embedding and each published document's embedding. | `search.embeddings` + `ctx embed` |
| `hybrid` | Weighted reciprocal rank fusion (k0 = 60, w/(k0+rank), weights from `search.fusion_weights`, default lexical 1 : semantic 2) of the lexical and semantic lists (top `candidates` of each, default 100). Exact matches stay deterministic: a document whose title equals the query, or that carries a `#tag` written in the query, is pinned above the fused list. | same as semantic |

`--rerank` (`rerank: true`) re-scores the top `search.rerank.top_n` (default 100) non-seed hits with the configured reranker. Seeds stay pinned.

### Rerank on passages, not whole documents

By default (`search.rerank.unit: passage`), the reranker never sees a whole document:

1. Each of the top `top_n` (100) candidates is split into windows of about 300 tokens (1,200 characters). Splits follow paragraphs, then sentences, and consecutive windows overlap by about 150 characters.
2. Each candidate's single best window is picked **locally, with no API call**. Windows are scored against the query with the same stemmed BM25 the lexical search uses, and ties go to the earlier window. Windows are never embedded.
3. Those windows go to the reranker as **one request of at most 100 passages**, which is the same budget Bedrock KB's reranker uses. The title is prefixed to each window.
4. Each document scores as its window's rerank score, and that window is returned as `passage` on the hit (`--json`), ready to quote in an answer.

When `max_passages` is larger than `top_n`, later rounds add each document's next-best window, highest local score first, and the document keeps its best rerank score. A budget above `batch_size` (100) adds more requests.

Why: a cross-encoder judges a (query, passage) pair. Fed a whole 3–4k-token article, the off-topic text dilutes the paragraph that answers the question. Bedrock Knowledge Bases rerank ~300-token chunks. On MultiHop-RAG (529 queries, NDCG@10), Bedrock KB vector + Cohere Rerank 3.5 over its top-100 chunks scored 0.795. A local proxy of ctx hybrid + rerank over the top-50 whole documents scored about 0.766. Passage rerank plus the larger top-100 is aimed at that gap. `unit: document` keeps the old behaviour.

**Cost:** with the defaults (`top_n` 100, `max_passages` 100, `batch_size` 100), a reranked query makes **one** rerank request, whatever the document lengths. In general it makes ceil(`max_passages` / `batch_size`) requests. Each request counts against Bedrock's per-minute quota (Cohere Rerank 3.5 on-demand is 25 per minute on a default account), and throttling is retried with backoff.

Every hit carries `score` (what the list is ordered by) and `scores` (`lexical`, `semantic`, `rrf`, `rerank` — whichever applied). The response says which `mode` actually ran.

## Defaults

### Why lexical ranking changed (benchmarks, NDCG@10)

Two defaults moved, both measured on BEIR SciFact and NFCorpus and on MultiHop-RAG (the dev sets; the held-out sets were not touched):

1. **No coordination factor.** MiniSearch multiplies each hit's BM25 sum by the number of query terms it matched. On long questions, that let a document touching many common words outrank one holding the single rare, discriminative term. Dividing the factor back out gives the plain BM25 sum: MultiHop-RAG 0.657 → 0.706, SciFact 0.668 → 0.662, NFCorpus 0.323 → 0.327. The noise floor (`MIN_RELATIVE_SCORE`) still applies to MiniSearch's raw score, where it was calibrated, so the set of hits is unchanged and only their order differs. Set `search.coordination: true` for the old ranking.
2. **Field boosts all 1.** The old boosts (title 3, tags 2, description 1.5) let one incidental title word outrank documents that are on topic in their body. Once coordination is removed, any title boost hurts: title 1.25 gives SciFact 0.593 and MultiHop-RAG 0.606. Title lookup ("find the node called X") is served by exact-match seeds instead. In every mode, a document whose title equals the query, or that carries a `#tag` written in the query, is pinned first. Vaults that want the old weighting can set `search.field_boosts: { title: 3, tags: 2, description: 1.5 }`.

For reference, on SciFact the shipped engine 3.0.0 scored 0.604 and a plain stemmed BM25 baseline scored 0.690.


With no `--mode`, search is **lexical**. A vault can opt into a different default with `search.mode`, and that default takes effect only once an index exists. Until `ctx embed` has run, a vault configured for `hybrid` still answers lexically instead of failing. An explicit `--mode semantic|hybrid` with no config or no index is an error that names the fix.

### Why hybrid weights semantic 2:1

Each list adds `w / (60 + rank)`. The default `{ lexical: 1, semantic: 2 }` was chosen by a dev-set sweep of 1:1, 1:1.5, 1:2 and 1:3 on BEIR SciFact and NFCorpus, with bge-base-en-v1.5 as the dense model. The held-out benchmark sets were not touched.

| NDCG@10 | 1:1 | 1:2 | dense only |
| --- | --- | --- | --- |
| SciFact | 0.726 | **0.747** | 0.740 |
| NFCorpus | 0.370 | 0.370 | 0.374 |

At 1:1, fusion fell below dense-only on SciFact, because the lexical list's weaker ranks diluted strong semantic hits. At 1:2, SciFact beats dense-only and NFCorpus is unchanged, with the best Recall@100 (0.342). Vaults with very keyword-heavy content can set `fusion_weights: { lexical: 1, semantic: 1 }`.

## Configuration (`.context/config.yaml`)

```yaml
search:
  mode: hybrid                 # optional default; lexical if omitted
  full_match_first: true       # lexical all-terms tier (default true)
  coordination: false          # true = legacy MiniSearch score x matched-term count
  field_boosts: { title: 1, tags: 1, description: 1, body: 1 }   # BM25 per-field boosts (defaults shown)
  candidates: 100              # per-list depth fused by RRF
  fusion_weights: { lexical: 1, semantic: 2 }   # hybrid: each list adds w/(60+rank); default 1:2
  embeddings:
    provider: bedrock          # bedrock | openai (also: openai-compatible, ollama, vllm)
    model: cohere.embed-v4:0   # or amazon.titan-embed-text-v2:0, us.cohere.embed-v4:0, ...
    region: us-east-1          # bedrock; else AWS_REGION (must look like an AWS region)
    dimensions: 1024           # optional output dimension
    batch_size: 32
    max_chars: 20000           # text embedded per document is cut here
    max_request_chars: 200000  # total characters per embedding request; batches split to fit
  rerank:
    provider: bedrock
    model: cohere.rerank-v3-5:0
    top_n: 100                 # non-seed hits reranked
    unit: passage              # passage (default) | document
    max_passages: 100          # windows per query (default 100 = one request; >top_n adds next-best windows)
    batch_size: 100            # sources per rerank request
```

OpenAI-compatible endpoints (OpenAI, Ollama, vLLM, LM Studio):

```yaml
search:
  embeddings:
    provider: openai
    model: nomic-embed-text
    base_url: http://localhost:11434/v1   # default https://api.openai.com/v1
    api_key_env: OPENAI_API_KEY           # the NAME of an env var, never the key itself
```

`config.yaml` is shared with the vault, so it is treated as untrusted. `api_key_env` must name a variable ending in `_API_KEY`, `base_url` must be an http(s) URL, and `region` must look like an AWS region (it becomes part of the Bedrock hostname). With a custom `base_url` no key is sent unless `api_key_env` names one: the `OPENAI_API_KEY` / `RERANK_API_KEY` fallback goes only to the default OpenAI host. Before you use a vault you did not write, check where its `search` block sends your queries and which key it names.

The block is validated when search uses it, never when the config is loaded, so a typo here cannot break other commands.

### Bedrock credentials

- `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key) → plain HTTPS. No extra install.
- Otherwise the engine lazily imports `@aws-sdk/client-bedrock-runtime` and uses the standard AWS credential chain. Install that package next to `ctx` (`npm i -g @aws-sdk/client-bedrock-runtime`). It is never a dependency of the base install.

### Throttling

Bedrock quotas are per minute and can be small. On a default account, Cohere Rerank 3.5 on-demand is 25 requests per minute, and Cohere Embed v4 has per-minute token quotas. Every Bedrock and OpenAI-compatible call therefore retries `ThrottlingException`, `TooManyRequestsException`, `ServiceUnavailableException` and HTTP 429/502/503. It uses exponential backoff with full jitter (1s base, 60s cap per wait, 8 attempts) and honours `Retry-After` when present.

Dropped connections and timeouts are retried the same way. That covers smithy's "pending stream has been canceled", `TimeoutError`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, "socket hang up" and undici's "terminated". Each request times out after 300s. The AWS SDK client runs with `maxAttempts: 1`, so its retries don't multiply ours.

Those limits are for `ctx embed`. A search (the query embedding and the rerank) has someone waiting on it, often a prompt hook, so it gets 2 attempts, a 2s backoff cap and a 20s timeout per request, and then fails.

Each embedding request is also capped at `max_request_chars` total characters (default 200,000). A `batch_size` batch of long documents is split to fit, and a single over-long document is sent on its own. `ctx embed` backs off per request, and an interrupted run resumes from the last saved batch.

## The index

`ctx embed` (MCP: `context_embed`) builds or refreshes it.

- **Only published documents are embedded.** Drafts, held, rejected, and forgotten documents are never sent to a provider. `ctx forget` and `ctx delete` remove the document's vector at once. A superseded version's vector is never served and is dropped by the next `ctx embed`.
- Each vector is keyed by **document id + version + SHA-256 of the embedded text** (title, description, body). A new version invalidates its own vector and nothing else. Search ignores a vector whose key no longer matches (it reports the count as `embeddings_stale`). The next `ctx embed` re-embeds new and changed documents, reuses current ones and prunes the rest. `--rebuild` starts over.
- Stored at `.context/embeddings/<provider>--<model>[--d<dims>].vec`: a JSON header with the keys, then the unit vectors (float32 LE), replaced by a single rename so a search never reads half of a save. There is one file per provider and model, so switching models never mixes vector spaces. The directory writes its own `.gitignore` (`*`) because the index is derived and rebuildable and is never committed.
- `ctx embed` does not hold the vault write lock while it calls the provider, so writes are not blocked during a long run. It takes the lock only to save, and each save keeps only vectors that still match a published document.
- Against a remote nest, `ctx embed` runs the nest's `context_embed` if it has one, and otherwise refuses.
- Encrypted vaults refuse `ctx embed`, because vectors are a plaintext-derived copy of sealed content. They also refuse `--rerank` (it would send decrypted text to the reranker) and an explicit semantic/hybrid search; a configured `search.mode` falls back to lexical.
- Each document gets one vector. Long documents are cut at `max_chars`. Section-level chunking is not implemented yet.
