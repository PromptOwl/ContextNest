/**
 * `search:` block of `.context/config.yaml` — retrieval modes.
 *
 *   search:
 *     mode: lexical            # default for searches that name no mode: lexical | semantic | hybrid
 *     full_match_first: true   # lexical: pin all-terms matches above partial ones
 *     field_boosts: { title: 1.25, tags: 1.25, description: 1, body: 1 }   # BM25 per-field boosts (these are the defaults)
 *     candidates: 100          # per-list depth fused by RRF
 *     fusion_weights: { lexical: 1, semantic: 2 }   # hybrid: w/(60+rank) per list (default 1:2)
 *     embeddings:
 *       provider: bedrock      # bedrock | openai (any OpenAI-compatible /embeddings: OpenAI, Ollama, vLLM)
 *       model: cohere.embed-v4:0
 *       region: us-east-1      # bedrock only (else AWS_REGION)
 *       base_url: http://localhost:11434/v1   # openai only
 *       api_key_env: OPENAI_API_KEY           # openai only: NAME of the env var holding the key
 *       dimensions: 1024       # optional output dimension
 *       batch_size: 32
 *       max_chars: 20000       # text sent per document is cut here
 *     rerank:
 *       provider: bedrock
 *       model: cohere.rerank-v3-5:0
 *       top_n: 50
 *
 * Like the structure rules, this block is parsed only where it is used (here),
 * never in `nestConfigSchema`: a typo in it must not brick every read of the
 * vault. Keys are never secrets — a key is named by env var, not inlined,
 * because config.yaml is committed.
 */
import { z } from "zod";
import { ConfigError } from "../errors.js";

export const SEARCH_MODES = ["lexical", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const providerFields = {
  provider: z.string().min(1),
  model: z.string().min(1),
  region: z.string().optional(),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
};

export const embeddingsConfigSchema = z
  .object({
    ...providerFields,
    dimensions: z.number().int().positive().optional(),
    batch_size: z.number().int().positive().optional(),
    max_chars: z.number().int().positive().optional(),
  })
  .strict();

export const rerankConfigSchema = z
  .object({
    ...providerFields,
    top_n: z.number().int().positive().optional(),
  })
  .strict();

export const searchConfigSchema = z
  .object({
    mode: z.enum(SEARCH_MODES).optional(),
    full_match_first: z.boolean().optional(),
    field_boosts: z
      .object({
        title: z.number().nonnegative().optional(),
        tags: z.number().nonnegative().optional(),
        description: z.number().nonnegative().optional(),
        body: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    candidates: z.number().int().positive().optional(),
    fusion_weights: z
      .object({
        lexical: z.number().nonnegative().optional(),
        semantic: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    embeddings: embeddingsConfigSchema.optional(),
    rerank: rerankConfigSchema.optional(),
  })
  .strict();

export type EmbeddingsConfig = z.infer<typeof embeddingsConfigSchema>;
export type RerankConfig = z.infer<typeof rerankConfigSchema>;
export type SearchConfig = z.infer<typeof searchConfigSchema>;

/** Validate the raw `search:` value of config.yaml (absent → `{}`). */
export function parseSearchConfig(raw: unknown): SearchConfig {
  if (raw === undefined || raw === null) return {};
  const result = searchConfigSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `search.${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid search config in config.yaml: ${messages.join("; ")}`);
  }
  return result.data;
}
