# Retrieval modes: lexical, semantic, hybrid

`ctx search` / `context_search` run in one of three modes:

| Mode | What ranks | Needs |
| --- | --- | --- |
| `lexical` (default) | BM25 over title/description/body/tags, English-stemmed (Porter) at index and query time, stopwords dropped. Field boosts default to title 1.25, tags 1.25, description 1, body 1 (`search.field_boosts`). Documents matching every term are pinned first unless `search.full_match_first: false`. | nothing |
| `semantic` | Cosine similarity between the query embedding and each published document's embedding. | `search.embeddings` + `ctx embed` |
| `hybrid` | Weighted reciprocal rank fusion (k0 = 60, w/(k0+rank), weights from `search.fusion_weights`, default lexical 1 : semantic 2) of the lexical and semantic lists (top `candidates` of each, default 100). Exact matches stay deterministic: a document whose title equals the query, or that carries a `#tag` written in the query, is pinned above the fused list. | same as semantic |

`--rerank` (`rerank: true`) re-scores the top `search.rerank.top_n` (default 50) non-seed hits with the configured reranker. Seeds stay pinned.

Every hit carries `score` (what the list is ordered by) and `scores` (`lexical`, `semantic`, `rrf`, `rerank` — whichever applied). The response says which `mode` actually ran.

## Defaults

The field boosts used to be title 3, tags 2, description 1.5. MiniSearch already length-normalizes each field, so a single incidental title word outranked documents that discuss the topic in their body. On BEIR SciFact that cost about 0.04 NDCG@10. The lower default fixes this. Title lookup ("find the node called X") is served by exact-match seeds instead. In every mode, a document whose title equals the query, or that carries a `#tag` written in the query, is pinned first. Vaults that want the old weighting can set `search.field_boosts: { title: 3, tags: 2, description: 1.5 }`.


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
  field_boosts: { title: 1.25, tags: 1.25, description: 1, body: 1 }   # BM25 per-field boosts (defaults shown)
  candidates: 100              # per-list depth fused by RRF
  fusion_weights: { lexical: 1, semantic: 2 }   # hybrid: each list adds w/(60+rank); default 1:2
  embeddings:
    provider: bedrock          # bedrock | openai (also: openai-compatible, ollama, vllm)
    model: cohere.embed-v4:0   # or amazon.titan-embed-text-v2:0, us.cohere.embed-v4:0, ...
    region: us-east-1          # bedrock; else AWS_REGION
    dimensions: 1024           # optional output dimension
    batch_size: 32
    max_chars: 20000           # text embedded per document is cut here
  rerank:
    provider: bedrock
    model: cohere.rerank-v3-5:0
    top_n: 50
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

The block is validated when search uses it, never when the config is loaded, so a typo here cannot break other commands.

### Bedrock credentials

- `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key) → plain HTTPS. No extra install.
- Otherwise the engine lazily imports `@aws-sdk/client-bedrock-runtime` and uses the standard AWS credential chain. Install that package next to `ctx` (`npm i -g @aws-sdk/client-bedrock-runtime`). It is never a dependency of the base install.

## The index

`ctx embed` (MCP: `context_embed`) builds or refreshes it.

- **Only published documents are embedded.** Drafts, held, rejected, and forgotten documents, and superseded versions, are never sent to a provider or stored.
- Each vector is keyed by **document id + version + SHA-256 of the embedded text** (title, description, body). A new version invalidates its own vector and nothing else. Search ignores a vector whose key no longer matches (it reports the count as `embeddings_stale`). The next `ctx embed` re-embeds new and changed documents, reuses current ones and prunes the rest. `--rebuild` starts over.
- Stored at `.context/embeddings/<provider>--<model>[--d<dims>].json` (keys) + `.f32` (unit vectors, float32 LE). There is one pair per provider and model, so switching models never mixes vector spaces. The directory writes its own `.gitignore` (`*`) because the index is derived and rebuildable and is never committed.
- Encrypted vaults refuse `ctx embed`, because vectors are a plaintext-derived copy of sealed content.
- Each document gets one vector. Long documents are cut at `max_chars`. Section-level chunking is not implemented yet.
