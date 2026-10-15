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
import { API_KEY_ENV_PATTERN, type EmbeddingsConfig, type RerankConfig } from "./config.js";
import {
  BedrockHttpError,
  BEDROCK_REQUEST_TIMEOUT_MS,
  type CallOptions,
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

/** `call`: retry/timeout budget (search passes INTERACTIVE_CALL; omitted = the embed defaults). */
export type EmbeddingProviderFactory = (cfg: EmbeddingsConfig, call?: CallOptions) => EmbeddingProvider;
export type RerankerFactory = (cfg: RerankConfig, call?: CallOptions) => Reranker;

const embeddingFactories = new Map<string, EmbeddingProviderFactory>();
const rerankFactories = new Map<string, RerankerFactory>();

export function registerEmbeddingProvider(name: string, factory: EmbeddingProviderFactory): void {
  embeddingFactories.set(name, factory);
}

export function registerReranker(name: string, factory: RerankerFactory): void {
  rerankFactories.set(name, factory);
}

export function createEmbeddingProvider(cfg: EmbeddingsConfig, call?: CallOptions): EmbeddingProvider {
  const factory = embeddingFactories.get(cfg.provider);
  if (!factory) {
    throw new ConfigError(
      `Unknown search.embeddings.provider "${cfg.provider}" — use one of: ${[...embeddingFactories.keys()].join(", ")}`,
    );
  }
  return factory(cfg, call);
}

export function createReranker(cfg: RerankConfig, call?: CallOptions): Reranker {
  const factory = rerankFactories.get(cfg.provider);
  if (!factory) {
    throw new ConfigError(
      `Unknown search.rerank.provider "${cfg.provider}" — use one of: ${[...rerankFactories.keys()].join(", ")}`,
    );
  }
  return factory(cfg, call);
}

// ─── OpenAI-compatible HTTP (OpenAI, Ollama, vLLM, LM Studio, TEI …) ─────────

/**
 * The bearer key. A named `api_key_env` must end in _API_KEY (checked again
 * here for callers that skip parseSearchConfig); the implicit fallback env is
 * read only when the vault set no `base_url` — a key is never handed to a
 * URL the vault chose unless the vault names that key.
 */
function apiKey(cfg: { api_key_env?: string; base_url?: string }, fallbackEnv: string): string | undefined {
  if (cfg.api_key_env !== undefined) {
    if (!API_KEY_ENV_PATTERN.test(cfg.api_key_env)) {
      throw new ConfigError(`api_key_env "${cfg.api_key_env}" must name an env var ending in _API_KEY`);
    }
    return process.env[cfg.api_key_env] || undefined;
  }
  return cfg.base_url ? undefined : process.env[fallbackEnv] || undefined;
}

/** POST JSON, retrying 429/502/503/504 and dropped connections/timeouts with the same backoff as Bedrock (Retry-After honoured). */
function postJson(url: string, body: unknown, key: string | undefined, call: CallOptions = {}): Promise<any> {
  return withBedrockRetry(() => postJsonOnce(url, body, key, call.timeoutMs ?? BEDROCK_REQUEST_TIMEOUT_MS), call);
}

async function postJsonOnce(url: string, body: unknown, key: string | undefined, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    // A request carrying a bearer key is never followed to another host.
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
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

export const TRUSTED_ENDPOINTS_ENV = "CONTEXTNEST_TRUSTED_ENDPOINTS";

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * The endpoint, checked. `base_url` comes from the vault config, which a
 * cloned or imported vault controls; queries, document text and (when the
 * config names one) an API key go there. So only the default OpenAI host and
 * loopback (Ollama, vLLM on this machine) are called on the vault's say-so;
 * any other host must be listed by the USER in CONTEXTNEST_TRUSTED_ENDPOINTS
 * (comma-separated hostnames).
 */
function baseUrl(cfg: { base_url?: string }): string {
  const url = (cfg.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const host = new URL(url).hostname.toLowerCase();
  const trusted = (process.env[TRUSTED_ENDPOINTS_ENV] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (host !== "api.openai.com" && !isLoopback(host) && !trusted.includes(host)) {
    throw new ConfigError(
      `search base_url host "${host}" comes from the vault config and is not trusted — ` +
        `add it to ${TRUSTED_ENDPOINTS_ENV} (comma-separated hostnames) in your environment to allow it`,
    );
  }
  return url;
}

export function createOpenAiEmbeddingProvider(cfg: EmbeddingsConfig, call?: CallOptions): EmbeddingProvider {
  return {
    name: cfg.provider,
    model: cfg.model,
    async embed(texts) {
      const out = await postJson(
        `${baseUrl(cfg)}/embeddings`,
        { model: cfg.model, input: texts, ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}) },
        apiKey(cfg, "OPENAI_API_KEY"),
        call,
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
export function createOpenAiReranker(cfg: RerankConfig, call?: CallOptions): Reranker {
  return {
    name: cfg.provider,
    model: cfg.model,
    async rerank(query, documents, topN) {
      const out = await postJson(
        `${baseUrl(cfg)}/rerank`,
        { model: cfg.model, query, documents, top_n: topN },
        apiKey(cfg, "RERANK_API_KEY"),
        call,
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
registerEmbeddingProvider("bedrock", (cfg, call) => createBedrockEmbeddingProvider(cfg, undefined, call));
registerReranker("bedrock", (cfg, call) => createBedrockReranker(cfg, undefined, call));
