/**
 * Amazon Bedrock embedding + rerank providers (InvokeModel).
 *
 * Models: Cohere Embed (`cohere.embed-v4:0`, v3 ids, and cross-region
 * inference-profile ids like `us.cohere.embed-v4:0`), Titan Text Embeddings v2
 * (`amazon.titan-embed-text-v2:0`), Cohere Rerank 3.5 (`cohere.rerank-v3-5:0`).
 *
 * Transport, chosen at call time and never at import:
 *  1. `AWS_BEARER_TOKEN_BEDROCK` set → plain `fetch` with the Bedrock API key.
 *     Zero dependencies.
 *  2. otherwise → `@aws-sdk/client-bedrock-runtime`, imported LAZILY by a
 *     computed specifier so no bundler inlines it and a base install never
 *     needs it. It is an optional peer dependency: install it next to `ctx`
 *     (`npm i -g @aws-sdk/client-bedrock-runtime`) to use SigV4 credentials
 *     (profiles, SSO, instance roles).
 */
import type { EmbeddingsConfig, RerankConfig } from "./config.js";
import type { EmbeddingProvider, EmbedKind, Reranker } from "./providers.js";

/** `(modelId, JSON body) → parsed JSON response`. Injected in tests. */
export type BedrockInvoke = (modelId: string, body: Record<string, unknown>) => Promise<any>;

const SDK_SPECIFIER = ["@aws-sdk", "client-bedrock-runtime"].join("/");

/**
 * Retry policy for throttling / transient unavailability. Bedrock quotas are
 * per MINUTE and can be tiny (Cohere Rerank 3.5 on-demand: 25 requests/min
 * on a default account), so a long benchmark or a large `ctx embed` WILL hit
 * them; failing the whole run on the first ThrottlingException is wrong.
 * Exponential backoff with full jitter, capped, honouring Retry-After.
 */
export interface RetryOptions {
  /** Total attempts including the first (default 8). */
  attempts?: number;
  /** First backoff ceiling in ms (default 1000). */
  baseMs?: number;
  /** Max single wait in ms (default 60000). */
  capMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "ModelNotReadyException",
]);

/** An HTTP/SDK error carrying what the retry policy needs. */
export class BedrockHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly errorName?: string,
  ) {
    super(message);
    this.name = errorName ?? "BedrockHttpError";
  }
}

/** Retry-After as seconds or an HTTP date → ms (undefined if absent/unparseable). */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function retryInfo(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  const e = err as any;
  const name: string | undefined = e?.errorName ?? e?.name ?? e?.__type;
  const status: number | undefined = e?.status ?? e?.$metadata?.httpStatusCode;
  const retryable =
    (name !== undefined && RETRYABLE_NAMES.has(name)) || status === 429 || status === 503 || status === 502;
  const header = e?.$response?.headers?.["retry-after"] ?? e?.$response?.headers?.["Retry-After"];
  return { retryable, retryAfterMs: e?.retryAfterMs ?? parseRetryAfter(header) };
}

export async function withBedrockRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const { retryable, retryAfterMs } = retryInfo(err);
      if (!retryable || attempt >= attempts) throw err;
      const backoff = random() * Math.min(cap, base * 2 ** (attempt - 1));
      await sleep(Math.min(cap, Math.max(backoff, retryAfterMs ?? 0)));
    }
  }
}

function regionOf(cfg: { region?: string }): string {
  return cfg.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

/** Default transport (see file header). */
export function defaultBedrockInvoke(region: string): BedrockInvoke {
  let sdkClient: Promise<{ send: (cmd: unknown) => Promise<any>; Command: any }> | undefined;
  return async (modelId, body) => {
    const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (token) {
      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new BedrockHttpError(
          `Bedrock ${modelId} → HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          parseRetryAfter(res.headers.get("retry-after")),
          res.headers.get("x-amzn-errortype")?.split(":")[0] || undefined,
        );
      }
      return res.json();
    }
    sdkClient ??= (async () => {
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ SDK_SPECIFIER);
      } catch {
        throw new Error(
          "Bedrock needs either AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) or the optional package " +
            "@aws-sdk/client-bedrock-runtime installed next to ctx (npm i -g @aws-sdk/client-bedrock-runtime).",
        );
      }
      const client = new mod.BedrockRuntimeClient({ region });
      return { send: (cmd: unknown) => client.send(cmd), Command: mod.InvokeModelCommand };
    })();
    const { send, Command } = await sdkClient;
    const out = await send(
      new Command({ modelId, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) }),
    );
    return JSON.parse(new TextDecoder().decode(out.body));
  };
}

function isCohere(model: string): boolean {
  return /(^|\.)cohere\.embed/.test(model);
}
function isTitan(model: string): boolean {
  return /(^|\.)amazon\.titan-embed/.test(model);
}

/** Run `fn` over `items` with at most `limit` in flight, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createBedrockEmbeddingProvider(
  cfg: EmbeddingsConfig,
  invoke?: BedrockInvoke,
  retry?: RetryOptions,
): EmbeddingProvider {
  const raw = invoke ?? defaultBedrockInvoke(regionOf(cfg));
  const call: BedrockInvoke = (m, b) => withBedrockRetry(() => raw(m, b), retry);
  const model = cfg.model;
  if (!isCohere(model) && !isTitan(model)) {
    throw new Error(
      `Unsupported Bedrock embedding model "${model}" — use cohere.embed-v4:0, a cohere.embed-* v3 model, or amazon.titan-embed-text-v2:0`,
    );
  }
  return {
    name: cfg.provider,
    model,
    async embed(texts: string[], kind: EmbedKind) {
      if (texts.length === 0) return [];
      if (isTitan(model)) {
        // Titan takes one text per request.
        return mapLimit(texts, 8, async (inputText) => {
          const out = await call(model, {
            inputText,
            ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
            normalize: true,
          });
          return out.embedding as number[];
        });
      }
      // Cohere: up to 96 texts per request.
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 96) {
        const batch = texts.slice(i, i + 96);
        const out = await call(model, {
          texts: batch,
          input_type: kind === "query" ? "search_query" : "search_document",
          embedding_types: ["float"],
          ...(cfg.dimensions ? { output_dimension: cfg.dimensions } : {}),
        });
        const got = Array.isArray(out.embeddings) ? out.embeddings : out.embeddings?.float;
        if (!Array.isArray(got) || got.length !== batch.length) {
          throw new Error(`Bedrock ${model} returned ${got?.length ?? 0} vectors for ${batch.length} texts`);
        }
        vectors.push(...got);
      }
      return vectors;
    },
  };
}

export function createBedrockReranker(cfg: RerankConfig, invoke?: BedrockInvoke, retry?: RetryOptions): Reranker {
  const raw = invoke ?? defaultBedrockInvoke(regionOf(cfg));
  const call: BedrockInvoke = (m, b) => withBedrockRetry(() => raw(m, b), retry);
  return {
    name: cfg.provider,
    model: cfg.model,
    async rerank(query, documents, topN) {
      if (documents.length === 0) return [];
      const out = await call(cfg.model, { query, documents, top_n: Math.min(topN, documents.length), api_version: 2 });
      return ((out.results ?? []) as Array<{ index: number; relevance_score: number }>).map((r) => ({
        index: r.index,
        score: r.relevance_score,
      }));
    },
  };
}
