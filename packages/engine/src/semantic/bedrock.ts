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
        throw new Error(`Bedrock ${modelId} → HTTP ${res.status}: ${text.slice(0, 300)}`);
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

export function createBedrockEmbeddingProvider(cfg: EmbeddingsConfig, invoke?: BedrockInvoke): EmbeddingProvider {
  const call = invoke ?? defaultBedrockInvoke(regionOf(cfg));
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

export function createBedrockReranker(cfg: RerankConfig, invoke?: BedrockInvoke): Reranker {
  const call = invoke ?? defaultBedrockInvoke(regionOf(cfg));
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
