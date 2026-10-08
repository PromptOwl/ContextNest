/**
 * Performance budget gate.
 *
 * Runs the benchmarks and fails if the engine's scaling has regressed.
 *
 * The gate is deliberately NOT a table of millisecond ceilings. CI runners
 * differ by several times in speed, and shared runners are noisy neighbours;
 * absolute budgets tight enough to catch a real regression would fail
 * constantly on a slow runner, and budgets loose enough to survive one would
 * catch nothing. Either way the job gets muted, which is worse than no gate.
 *
 * What is stable across hardware is SHAPE. An operation that costs the same per
 * document at 1k and at 10k is linear; one whose per-document cost climbs is
 * not, and that is the failure the ticket is actually about — "engine slows
 * down as vault size grows". A quadratic path shows the same climb on a fast
 * runner as a slow one.
 *
 * So: per-operation scaling tolerance, expressed as how much the per-document
 * cost may grow across a 10× increase in vault size. Anything comfortably under
 * 2× is linear with measurement noise; the tolerances in budget.json are set
 * per operation, above today's measured value with headroom, and tightened as
 * each hot path is fixed.
 *
 * Usage:
 *   node bench/check.mjs                     # run benchmarks, then gate
 *   node bench/check.mjs --input results.json
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

function parseArgs(argv) {
  const args = { input: null, sizes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--sizes") args.sizes = argv[++i];
  }
  return args;
}

const { input, sizes } = parseArgs(process.argv.slice(2));
const budget = JSON.parse(await readFile(join(here, "budget.json"), "utf-8"));

let report;
if (input) {
  report = JSON.parse(await readFile(input, "utf-8"));
} else {
  const argv = [join(here, "run.mjs"), "--out", join(here, "results-ci.json")];
  if (sizes) argv.push("--sizes", sizes);
  // maxBuffer: a 10k run prints a lot of engine chatter on stderr.
  await run(process.execPath, argv, { maxBuffer: 64 * 1024 * 1024 });
  report = JSON.parse(await readFile(join(here, "results-ci.json"), "utf-8"));
}

/** Per-document cost in microseconds, the size-independent unit. */
const perDoc = (entry, op) =>
  entry.ops[op] ? (entry.ops[op].p95 / entry.size) * 1000 : null;

const bySize = new Map(report.sizes.map((s) => [s.size, s]));
const failures = [];
const rows = [];
const pad = (s, n) => String(s).padEnd(n);

for (const rule of budget.scaling) {
  const op = rule.op;
  const from = bySize.get(rule.from);
  const to = bySize.get(rule.to);
  if (!from || !to) {
    // Not every run covers every size (a PR run stops at 1,000). Skipping is
    // correct; silently passing a rule that never ran is not — say so.
    rows.push(`  ~ ${op} [${rule.from}→${rule.to}]: skipped (size not in this run)`);
    continue;
  }
  const a = perDoc(from, op);
  const b = perDoc(to, op);
  if (a == null || b == null) {
    rows.push(`  ~ ${op} [${rule.from}→${rule.to}]: skipped (not measured)`);
    continue;
  }
  const growth = b / a;
  const ok = growth <= rule.maxGrowth;
  rows.push(
    `  ${ok ? "✓" : "✗"} ${pad(`${op} [${rule.from}→${rule.to}]`, 44)}` +
      `${a.toFixed(1)} → ${b.toFixed(1)} µs/doc  ` +
      `(${growth.toFixed(2)}×, budget ${rule.maxGrowth}×)`,
  );
  if (!ok) {
    failures.push(
      `${op}: per-document cost grew ${growth.toFixed(2)}× from ${rule.from} to ${rule.to} ` +
        `documents (budget ${rule.maxGrowth}×). The operation is scaling worse than linearly.`,
    );
  }
}

console.log(`\nPerformance budget — ${report.platform}, Node ${report.node}\n`);
console.log(rows.join("\n"));

if (failures.length) {
  console.error(`\n${failures.length} budget breach(es):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}
console.log("\nAll operations within their scaling budget.\n");
