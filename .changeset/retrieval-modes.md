---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**Retrieval modes: stemmed lexical search, plus opt-in semantic and hybrid search over published versions.**

- Lexical search now applies English (Porter) stemming at index and query time, so `migrations` finds `migration`. Stopwords are still dropped.
- **Ranking change:** the default BM25 field boosts drop from title 3 / tags 2 / description 1.5 to title 1.25 / tags 1.25 / description 1. A single incidental title word no longer outranks documents that are on topic in their body. Boosts are a Resolver option (`fieldBoosts`, config `search.field_boosts`). The all-terms-first tier becomes a Resolver option (`fullMatchFirst`, config `search.full_match_first`). The default is unchanged.
- New `ctx embed` / MCP `context_embed` builds an embedding index of **published** documents only. It is keyed by id + version + content hash, stored in `.context/embeddings/` (git-ignored), and is incremental.
- `ctx search --mode lexical|semantic|hybrid [--rerank]` / `context_search` `mode` + `rerank`. Hybrid uses weighted reciprocal rank fusion (k0 = 60, default lexical 1 : semantic 2, `search.fusion_weights`) and pins exact title/#tag matches. Hits carry per-signal `scores`, and the response names the `mode` that ran.
- Providers are pluggable and optional: Amazon Bedrock (Cohere Embed v4, Titan v2, Cohere Rerank 3.5, using a Bedrock API key over fetch or a lazily imported `@aws-sdk/client-bedrock-runtime`), and any OpenAI-compatible `/embeddings` endpoint (OpenAI, Ollama, vLLM). The base install adds no provider dependency.
- The default mode stays lexical. A vault's `search.mode` applies only once an index exists. See `docs/retrieval-modes.md`.
