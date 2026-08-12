/**
 * Engine benchmark harness — how the engine behaves as a vault grows.
 *
 * Answers the question a serious user actually asks before trusting a real
 * vault to this: does it stay usable at 10k documents, or does something in
 * here scale quadratically? Timings alone cannot answer that. A per-document
 * cost that holds steady from 1k to 10k means the op is linear; one that
 * doubles means it is not, and no absolute millisecond budget would tell them
 * apart on unknown hardware.
 *
 * So this reports BOTH: absolute p50/p95 per operation, and the per-document
 * cost at each size. `check.mjs` gates on the second.
 *
 * Runs against the built `dist`, not `src` — no TypeScript runner is in the
 * dependency tree, and measuring the shipped bundle is the more honest target
 * anyway.
 *
 * Usage:
 *   node bench/run.mjs                        # default sizes
 *   node bench/run.mjs --sizes 100,1000       # pick sizes
 *   node bench/run.mjs --out results.json     # write results
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { NestStorage, GraphQueryEngine, VersionManager } from "../dist/index.js";
import { createEngineApi } from "../dist/api/index.js";
import { generateVault } from "./fixture.mjs";

const DEFAULT_SIZES = [100, 1000, 10000];

function parseArgs(argv) {
  const args = { sizes: DEFAULT_SIZES, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sizes") {
      args.sizes = argv[++i].split(",").map((s) => Number(s.trim())).filter(Boolean);
    } else if (argv[i] === "--out") {
      args.out = argv[++i];
    }
  }
  return args;
}

/** p-th percentile of an unsorted sample, nearest-rank. */
function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[rank];
}

/**
 * Time `fn` over `reps` runs and return the distribution.
 *
 * One untimed warmup run first: the first call through any code path pays for
 * lazy module init and a cold JIT, and folding that into a p95 measures Node
 * warming up rather than the engine working.
 */
async function measure(fn, reps) {
  await fn();
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    runs: reps,
  };
}

/** Time a single run of an operation that mutates the vault (so cannot repeat). */
async function measureOnce(fn) {
  const t0 = performance.now();
  await fn();
  return { p50: performance.now() - t0, p95: performance.now() - t0, runs: 1 };
}

function makeContext(root) {
  const storage = new NestStorage(root);
  return {
    storage,
    query: new GraphQueryEngine(storage),
    versions: new VersionManager(storage),
    actor: "bench@contextnest.dev",
  };
}

async function benchSize(size) {
  const api = createEngineApi();
  const results = {};

  // ── Read-only operations, on a vault that is already published ────────────
  // Repeatable, so these get a real distribution. This is the path an agent
  // hits on every retrieval, which makes its p95 the number users feel.
  const readRoot = await mkdtemp(join(tmpdir(), `cn-bench-read-${size}-`));
  try {
    await generateVault(readRoot, size);
    const ctx = makeContext(readRoot);

    // Repetitions fall as the vault grows: at 10k a single crawl is already
    // substantial, and 20 of them would dominate the run for no extra signal.
    const reps = size >= 10000 ? 5 : size >= 1000 ? 10 : 20;

    results.discoverDocuments = await measure(() => ctx.storage.discoverDocuments(), reps);
    results.context_list = await measure(() => api.run("context_list", {}, ctx), reps);
    results.context_search = await measure(
      () => api.run("context_search", { query: "checkpoint" }, ctx),
      reps,
    );
    results.context_query = await measure(
      () => api.run("context_query", { query: "#architecture" }, ctx),
      reps,
    );
  } finally {
    await rm(readRoot, { recursive: true, force: true });
  }

  // ── Whole-vault write operations ──────────────────────────────────────────
  // Each mutates the vault, so each gets a fresh fixture and a single timed
  // run. These are the ops that made importing a large folder take minutes.
  const importRoot = await mkdtemp(join(tmpdir(), `cn-bench-import-${size}-`));
  try {
    await generateVault(importRoot, size);
    const ctx = makeContext(importRoot);
    results.context_import_discover = await measureOnce(() =>
      api.run("context_import", { discover: true, author: "bench@contextnest.dev" }, ctx),
    );
    // Index regeneration runs after the import above, on a published vault —
    // which is when it actually runs in production.
    results.regenerateIndex = await measureOnce(() => ctx.storage.regenerateIndex());
  } finally {
    await rm(importRoot, { recursive: true, force: true });
  }

  // Peak resident memory after the largest crawls. Reported per size so a
  // memory regression shows up as growth that outpaces the document count.
  const mem = process.memoryUsage();
  return {
    size,
    ops: results,
    memory: {
      rssMb: +(mem.rss / 1024 / 1024).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
    },
  };
}

const { sizes, out } = parseArgs(process.argv.slice(2));

const report = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  // No timestamp: it would make every result file differ from the last even
  // when nothing changed, which is noise in a committed baseline.
  sizes: [],
};

for (const size of sizes) {
  process.stderr.write(`benchmarking ${size} documents…\n`);
  report.sizes.push(await benchSize(size));
}

// ── Report ──────────────────────────────────────────────────────────────────
const opNames = [...new Set(report.sizes.flatMap((s) => Object.keys(s.ops)))];
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

console.log(`\nContextNest engine benchmarks — ${report.platform}, Node ${report.node}\n`);
console.log(
  `${pad("operation", 26)}${report.sizes.map((s) => pad(`${s.size} docs`, 22)).join("")}`,
);
console.log("-".repeat(26 + report.sizes.length * 22));
for (const op of opNames) {
  const cells = report.sizes.map((s) => {
    const r = s.ops[op];
    if (!r) return pad("—", 22);
    return pad(`${num(r.p95)}ms  ${num((r.p95 / s.size) * 1000)}µs/doc`, 22);
  });
  console.log(`${pad(op, 26)}${cells.join("")}`);
}
console.log(
  `\n${pad("peak RSS", 26)}${report.sizes.map((s) => pad(`${s.memory.rssMb} MB`, 22)).join("")}`,
);
console.log("\np95 shown. µs/doc is the scaling signal: flat means linear.\n");

if (out) {
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  process.stderr.write(`wrote ${out}\n`);
}
