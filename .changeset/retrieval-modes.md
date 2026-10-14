---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**Retrieval modes: stemmed lexical search, plus opt-in semantic and hybrid search over published versions.**

- Lexical search now applies English (Porter) stemming at index and query time, so `migrations` finds `migration`. Stopwords are still dropped.
- **Ranking change:** lexical scores are now the plain BM25 sum. MiniSearch's matched-term coordination factor is divided out (`search.coordination: true` restores it), and the default field boosts drop from title 3 / tags 2 / description 1.5 to all 1 (`search.field_boosts`). Exact title/#tag matches are pinned first in every mode, so title lookup keeps working. On MultiHop-RAG, NDCG@10 goes 0.657 → 0.706. See `docs/retrieval-modes.md`.
- New `ctx embed` / MCP `context_embed` builds an embedding index of **published** documents only. It is keyed by id + version + content hash, stored in `.context/embeddings/` (git-ignored), and is incremental.
- `ctx search --mode lexical|semantic|hybrid [--rerank]` / `context_search` `mode` + `rerank`. Hybrid uses weighted reciprocal rank fusion (k0 = 60, default lexical 1 : semantic 2, `search.fusion_weights`) and pins exact title/#tag matches. Hits carry per-signal `scores`, and the response names the `mode` that ran.
- Rerank works on passages by default (`search.rerank.unit: passage`). Each candidate's best ~300-token window is picked locally with stemmed BM25 (no API call), and the windows go to the reranker in one request of up to 100 passages. The hit carries its window as `passage`. The default `top_n` is 100.
- Providers are pluggable and optional: Amazon Bedrock (Cohere Embed v4, Titan v2, Cohere Rerank 3.5, using a Bedrock API key over fetch or a lazily imported `@aws-sdk/client-bedrock-runtime`), and any OpenAI-compatible `/embeddings` endpoint (OpenAI, Ollama, vLLM). The base install adds no provider dependency.
- The default mode stays lexical. A vault's `search.mode` applies only once an index exists. See `docs/retrieval-modes.md`.
