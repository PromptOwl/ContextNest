/**
 * Loopback OpenAI-compatible embedder + reranker — the offline provider J18's
 * semantic/hybrid search journey drives the INSTALLED CLI against.
 *
 * WHY A SEPARATE PROCESS: the journey harness drives the CLI with `spawnSync`,
 * which blocks the test process's event loop until the CLI exits. The CLI makes
 * an HTTP call to this provider mid-run — so a server sharing the test's event
 * loop could never answer it, and the CLI would hang. This runs as its own
 * process (spawned by `startMockProvider`), so its event loop is free to serve
 * the CLI's request while the test sits blocked in spawnSync. It prints
 * `PORT <n>` once listening, so the parent can read the port it bound.
 *
 * DETERMINISTIC "CONCEPT" EMBEDDER (the crux): real embeddings need a network
 * provider and an API key — neither is available offline in CI. Instead, each
 * text is mapped to a tiny fixed vector by counting how many of its words fall
 * in each hand-built concept bucket. Words that mean the same thing live in one
 * bucket, so a PARAPHRASE query ("charging customers") lands in the same concept
 * dimension as a node that never uses those words ("invoice", "billing") — which
 * is exactly what lets the journey prove semantic search finds a node by meaning
 * while lexical (stemmed-keyword) search misses it. The node bodies and queries
 * in J18 are written against these buckets; keep the two in sync.
 *
 * The HTTP contract mirrors the OpenAI shapes the engine's openai provider speaks
 * (see createOpenAiEmbeddingProvider / createOpenAiReranker in
 * packages/engine/src/semantic/providers.ts):
 *   POST /v1/embeddings  {model, input: string[], dimensions?} -> {data: [{index, embedding: number[]}]}
 *   POST /v1/rerank      {model, query, documents: string[], top_n} -> {results: [{index, relevance_score}]}
 */
import http from "node:http";

const DEFAULT_DIMS = Number(process.env.MOCK_DIMS || 8);

// Each bucket is a set of surface words that share one meaning. The journey only
// leans on "billing" vs "deployment"; the others keep the space from collapsing
// to a single axis (so an unrelated query is near nothing rather than everything).
const CONCEPTS = [
  // 0 — billing / revenue: a node uses invoice/billing/dunning/overdue; a query
  //     paraphrases it as charge/charging/payment/customers — different words,
  //     same bucket, so they embed near each other but share no lexical stem.
  ["invoice", "invoices", "billing", "dunning", "overdue", "charge", "charging",
    "charged", "payment", "payments", "customer", "customers", "revenue",
    "subscription", "subscriptions"],
  // 1 — deployment / release
  ["deploy", "deployment", "release", "releases", "rollout", "ship", "shipping",
    "shipped", "pipeline", "nightly"],
  // 2 — authentication (unused by J18 nodes; keeps the space honest)
  ["auth", "authentication", "login", "signin", "password", "credentials", "mfa", "sso"],
  // 3 — onboarding (unused by J18 nodes)
  ["onboard", "onboarding", "welcome", "newcomer", "hire", "hires"],
];

/** Count concept hits per bucket, pad/truncate to `dims`, floor the last dim so
 * an all-zero text still yields a usable (non-degenerate) vector. */
function conceptVector(text, dims) {
  const words = String(text).toLowerCase().split(/[^a-z]+/);
  const v = CONCEPTS.map((bucket) => words.filter((w) => bucket.includes(w)).length);
  while (v.length < dims) v.push(0);
  const out = v.slice(0, dims);
  out[dims - 1] = 0.01;
  return out;
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

const server = http.createServer(async (req, res) => {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    res.statusCode = 400;
    res.end("{}");
    return;
  }
  res.setHeader("content-type", "application/json");

  if (req.url.endsWith("/embeddings")) {
    const dims = Number(body.dimensions) || DEFAULT_DIMS;
    const input = Array.isArray(body.input) ? body.input : [];
    // Must return exactly one vector per input, in order.
    const data = input.map((text, index) => ({ index, embedding: conceptVector(text, dims) }));
    res.end(JSON.stringify({ data }));
    return;
  }

  if (req.url.endsWith("/rerank")) {
    const dims = DEFAULT_DIMS;
    const q = conceptVector(body.query, dims);
    const docs = Array.isArray(body.documents) ? body.documents : [];
    // Relevance = concept-space dot product with the query (deterministic): a doc
    // sharing the query's concept scores high, an unrelated one scores ~0.
    const results = docs.map((d, index) => {
      const dv = conceptVector(d, dims);
      return { index, relevance_score: dv.reduce((s, x, i) => s + x * q[i], 0) };
    });
    res.end(JSON.stringify({ results }));
    return;
  }

  res.statusCode = 404;
  res.end("{}");
});

// Port 0 = let the OS pick a free port; print it so the parent can target it.
server.listen(0, "127.0.0.1", () => console.log(`PORT ${server.address().port}`));

// Shut down if the parent's stdin pipe to us closes — the parent exited without
// killing us (e.g. the test runner was hard-killed), so don't linger as an orphan.
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
