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
import { AWS_REGION_PATTERN, type EmbeddingsConfig, type RerankConfig } from "./config.js";
import { ConfigError } from "../errors.js";
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

/** Retry policy plus the per-request timeout of one provider call. */
export interface CallOptions extends RetryOptions {
  /** Per-request timeout in ms (default BEDROCK_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Budget for calls made while someone waits on the answer (a search: the
 * query embedding and the rerank). The 8-attempt / 300s defaults are for
 * `ctx embed` batches; on a search they would hold a prompt hook for minutes.
 */
export const INTERACTIVE_CALL: Readonly<CallOptions> = Object.freeze({
  attempts: 2,
  capMs: 2_000,
  timeoutMs: 20_000,
});

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

/** Error names the SDK / undici / AbortSignal.timeout use for a dropped or slow request. */
const TRANSIENT_NAMES = new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException", "AbortError"]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "EAI_AGAIN", "UND_ERR_SOCKET"]);
/** Messages of transport failures with no structured code (smithy, node http, undici fetch). */
const TRANSIENT_MESSAGE = /pending stream has been canceled|socket hang up|^terminated$|other side closed|ECONNRESET|ETIMEDOUT|EPIPE/i;

/** A dropped connection / timed-out request: safe to resend (embed and rerank are idempotent). */
export function isTransientTransportError(err: unknown): boolean {
  for (let e: any = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (TRANSIENT_NAMES.has(e.name)) return true;
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
    if (typeof e.message === "string" && TRANSIENT_MESSAGE.test(e.message)) return true;
  }
  return false;
}

function retryInfo(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  const e = err as any;
  const name: string | undefined = e?.errorName ?? e?.name ?? e?.__type;
  const status: number | undefined = e?.status ?? e?.$metadata?.httpStatusCode;
  const retryable =
    (name !== undefined && RETRYABLE_NAMES.has(name)) ||
    status === 429 ||
    status === 503 ||
    status === 502 ||
    status === 504 ||
    isTransientTransportError(err);
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

/**
 * Per-request timeout. A Cohere batch of long documents can take well over a
 * minute; a timeout is retried like any transient error.
 */
export const BEDROCK_REQUEST_TIMEOUT_MS = 300_000;

/** Upper bound on characters sent in one embedding request (all texts summed). */
export const DEFAULT_MAX_REQUEST_CHARS = 200_000;

/**
 * Split texts into request batches of at most `maxItems` texts and
 * `maxChars` total characters (a single over-long text still goes alone).
 * Returns index ranges [start, end).
 */
export function requestBatches(texts: string[], maxItems: number, maxChars: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let chars = 0;
  for (let i = 0; i < texts.length; i++) {
    const len = texts[i].length;
    if (i > start && (i - start >= maxItems || chars + len > maxChars)) {
      out.push([start, i]);
      start = i;
      chars = 0;
    }
    chars += len;
  }
  if (start < texts.length) out.push([start, texts.length]);
  return out;
}

/** The region, checked: it is spliced into the hostname the bearer token is sent to. */
function regionOf(cfg: { region?: string }): string {
  const region = cfg.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new ConfigError(`Invalid AWS region "${region}" — expected e.g. us-east-1`);
  }
  return region;
}

/** Default transport (see file header). */
export function defaultBedrockInvoke(region: string, timeoutMs = BEDROCK_REQUEST_TIMEOUT_MS): BedrockInvoke {
  let sdkClient: Promise<{ send: (cmd: unknown) => Promise<any>; Command: any }> | undefined;
  return async (modelId, body) => {
    const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (token) {
      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
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
      // maxAttempts 1: withBedrockRetry owns retries (8 attempts, backoff,
      // Retry-After), so the SDK's own 3 attempts would multiply into 24.
      // requestHandler as an options object is the SDK v3 shorthand for a
      // NodeHttpHandler with these settings.
      const client = new mod.BedrockRuntimeClient({
        region,
        maxAttempts: 1,
        requestHandler: { requestTimeout: timeoutMs, connectionTimeout: 10_000 },
      });
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
  retry?: CallOptions,
): EmbeddingProvider {
  const raw = invoke ?? defaultBedrockInvoke(regionOf(cfg), retry?.timeoutMs);
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
      // Cohere: up to 96 texts and `max_request_chars` characters per request.
      const vectors: number[][] = [];
      const maxChars = cfg.max_request_chars ?? DEFAULT_MAX_REQUEST_CHARS;
      for (const [a, b] of requestBatches(texts, 96, maxChars)) {
        const batch = texts.slice(a, b);
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

export function createBedrockReranker(cfg: RerankConfig, invoke?: BedrockInvoke, retry?: CallOptions): Reranker {
  const raw = invoke ?? defaultBedrockInvoke(regionOf(cfg), retry?.timeoutMs);
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
