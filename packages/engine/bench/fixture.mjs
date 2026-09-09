/**
 * Generate a synthetic vault of N documents for benchmarking.
 *
 * Written with plain `fs` rather than through the engine on purpose: a fixture
 * built by the code under test would hide a regression in that code, and
 * publishing N documents to lay down a baseline would take longer than the
 * benchmark it feeds.
 *
 * The shape matters as much as the count. Real vaults are not a flat directory
 * of identical files, and an engine that only ever sees one is not being
 * measured on anything: documents are spread over a folder tree, bodies vary in
 * length, tags repeat with a realistic skew (a few hot tags, a long tail), and
 * a fraction carry wiki links to other documents so link resolution has real
 * work to do.
 *
 * Deterministic: same `size` in, byte-identical vault out. A benchmark whose
 * input drifts between runs measures the drift.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Bounded-parallel map — writing 10k files one await at a time is its own wait. */
async function inBatches(items, fn, size = 64) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * Deterministic PRNG (mulberry32). `Math.random()` would make every run a
 * different vault, so a result could never be compared to the run before it.
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = [
  "architecture", "api", "runbook", "decision", "onboarding",
  "security", "billing", "infra", "frontend", "data",
];

const WORDS = [
  "context", "vault", "document", "version", "checkpoint", "steward", "publish",
  "retrieval", "governance", "index", "chain", "keyframe", "review", "approve",
];

/** A body of roughly `n` words, stable for a given rand stream. */
function body(rand, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(" ");
}

/**
 * Write a vault of `size` documents under `root`.
 *
 * Returns the ids written, so a caller can drive per-document operations
 * without re-scanning the vault it just built.
 */
export async function generateVault(root, size, { seed = 1 } = {}) {
  const rand = rng(seed);
  // Roughly 20 documents per folder, two levels deep — enough that discovery
  // walks a real tree rather than one big readdir.
  const folders = Math.max(1, Math.ceil(size / 20));
  const ids = [];
  const docs = [];

  for (let i = 0; i < size; i++) {
    const folder = i % folders;
    const id = `nodes/area-${folder % 8}/topic-${folder}/doc-${i}`;
    ids.push(id);

    // Skewed tags: index 0 is on ~half the vault, the tail is rare. A uniform
    // spread would make every tag query cost the same and hide the hot-tag case.
    const tagCount = 1 + Math.floor(rand() * 3);
    const tags = [];
    for (let t = 0; t < tagCount; t++) {
      const skewed = Math.floor(TAGS.length * rand() * rand());
      const tag = TAGS[Math.min(skewed, TAGS.length - 1)];
      if (!tags.includes(tag)) tags.push(tag);
    }

    // A fifth of the vault links to another document, so link resolution and
    // the graph query engine have edges to actually traverse.
    const linksTo = rand() < 0.2 ? `doc-${Math.floor(rand() * size)}` : null;

    // Bodies vary: most short, some long. One fixed size would measure a single
    // point on the curve and call it the curve.
    const length = rand() < 0.1 ? 400 : 60;

    docs.push({
      id,
      content:
        `---\n` +
        `title: Doc ${i}\n` +
        `type: document\n` +
        `status: published\n` +
        `version: 1\n` +
        `tags:\n${tags.map((t) => `  - "#${t}"`).join("\n")}\n` +
        `---\n\n` +
        `# Doc ${i}\n\n` +
        `${body(rand, length)}\n` +
        (linksTo ? `\nSee also [[${linksTo}]].\n` : ""),
    });
  }

  // One mkdir per distinct folder, not per document.
  const dirs = new Set(docs.map((d) => join(root, d.id.split("/").slice(0, -1).join("/"))));
  await mkdir(root, { recursive: true });
  await Promise.all([...dirs].map((d) => mkdir(d, { recursive: true })));
  await inBatches(docs, (d) => writeFile(join(root, `${d.id}.md`), d.content, "utf-8"));

  return ids;
}
