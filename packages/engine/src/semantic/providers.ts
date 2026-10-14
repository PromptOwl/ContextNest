/**
 * Pluggable embedding and rerank providers.
 *
 * Nothing here is a mandatory dependency of the engine (CLI-hardening
 * commitment): the OpenAI-compatible provider is plain `fetch`, and Bedrock is
 * either `fetch` with a Bedrock API key or a LAZY import of the optional
 * `@aws-sdk/client-bedrock-runtime` (see bedrock.ts). A vault that never
 * configures `search.embeddings` never loads any of it.
 *
 * Built-ins: `openai` (aliases `openai-compatible`, `ollama`, `vllm`) and
 * `bedrock`. Hosts and tests add their own with `registerEmbeddingProvider` /
 * `registerReranker`.
 */
import { ConfigError } from "../errors.js";
import type { EmbeddingsConfig, RerankConfig } from "./config.js";
import {
  BedrockHttpError,
  createBedrockEmbeddingProvider,
  createBedrockReranker,
  parseRetryAfter,
  withBedrockRetry,
} from "./bedrock.js";

/** Which side of retrieval a text is on — asymmetric models embed them differently. */
export type EmbedKind = "document" | "query";

export interface EmbeddingProvider {
  /** Provider name as configured (part of the index file key). */
  readonly name: string;
  /** Model id as configured (part of the index file key). */
  readonly model: string;
  /** One vector per input text, in input order. */
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export interface Reranker {
  readonly name: string;
  readonly model: string;
  /** Up to `topN` `{index into documents, score}`, best first. */
  rerank(query: string, documents: string[], topN: number): Promise<Array<{ index: number; score: number }>>;
}

export type EmbeddingProviderFactory = (cfg: EmbeddingsConfig) => EmbeddingProvider;
export type RerankerFactory = (cfg: RerankConfig) => Reranker;

const embeddingFactories = new Map<string, EmbeddingProviderFactory>();
const rerankFactories = new Map<string, RerankerFactory>();

export function registerEmbeddingProvider(name: string, factory: EmbeddingProviderFactory): void {
  embeddingFactories.set(name, factory);
}

export function registerReranker(name: string, factory: RerankerFactory): void {
  rerankFactories.set(name, factory);
}

export function createEmbeddingProvider(cfg: EmbeddingsConfig): EmbeddingProvider {
  const factory = embeddingFactories.get(cfg.provider);
  if (!factory) {
    throw new ConfigError(
      `Unknown search.embeddings.provider "${cfg.provider}" — use one of: ${[...embeddingFactories.keys()].join(", ")}`,
    );
  }
  return factory(cfg);
}

export function createReranker(cfg: RerankConfig): Reranker {
  const factory = rerankFactories.get(cfg.provider);
  if (!factory) {
    throw new ConfigError(
      `Unknown search.rerank.provider "${cfg.provider}" — use one of: ${[...rerankFactories.keys()].join(", ")}`,
    );
  }
  return factory(cfg);
}

// ─── OpenAI-compatible HTTP (OpenAI, Ollama, vLLM, LM Studio, TEI …) ─────────

function apiKey(cfg: { api_key_env?: string }, fallbackEnv: string): string | undefined {
  return process.env[cfg.api_key_env ?? fallbackEnv] || undefined;
}

/** POST JSON, retrying 429/502/503 with the same backoff as Bedrock (Retry-After honoured). */
function postJson(url: string, body: unknown, key: string | undefined): Promise<any> {
  return withBedrockRetry(() => postJsonOnce(url, body, key));
}

async function postJsonOnce(url: string, body: unknown, key: string | undefined): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BedrockHttpError(
      `${url} → HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  return res.json();
}

function baseUrl(cfg: { base_url?: string }): string {
  return (cfg.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function createOpenAiEmbeddingProvider(cfg: EmbeddingsConfig): EmbeddingProvider {
  return {
    name: cfg.provider,
    model: cfg.model,
    async embed(texts) {
      const out = await postJson(
        `${baseUrl(cfg)}/embeddings`,
        { model: cfg.model, input: texts, ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}) },
        apiKey(cfg, "OPENAI_API_KEY"),
      );
      const data = (out?.data ?? []) as Array<{ index?: number; embedding: number[] }>;
      if (data.length !== texts.length) {
        throw new Error(`embeddings endpoint returned ${data.length} vectors for ${texts.length} inputs`);
      }
      return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    },
  };
}

/** Cohere/Jina-style `POST {base_url}/rerank` (vLLM and most rerank servers speak it). */
export function createOpenAiReranker(cfg: RerankConfig): Reranker {
  return {
    name: cfg.provider,
    model: cfg.model,
    async rerank(query, documents, topN) {
      const out = await postJson(
        `${baseUrl(cfg)}/rerank`,
        { model: cfg.model, query, documents, top_n: topN },
        apiKey(cfg, "RERANK_API_KEY"),
      );
      return ((out?.results ?? []) as Array<{ index: number; relevance_score: number }>).map((r) => ({
        index: r.index,
        score: r.relevance_score,
      }));
    },
  };
}

for (const name of ["openai", "openai-compatible", "ollama", "vllm"]) {
  registerEmbeddingProvider(name, createOpenAiEmbeddingProvider);
  registerReranker(name, createOpenAiReranker);
}
registerEmbeddingProvider("bedrock", (cfg) => createBedrockEmbeddingProvider(cfg));
registerReranker("bedrock", (cfg) => createBedrockReranker(cfg));
