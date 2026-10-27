#!/usr/bin/env node
/**
 * Time one document update on throwaway vaults of N published docs.
 *
 *   pnpm bench:write              # 200, 1000, 3000 docs
 *   pnpm bench:write 1000 10000   # chosen sizes
 *
 * Runs against the BUILT engine (packages/engine/dist), so build first —
 * `pnpm bench:write` does. Prints one JSON line per size:
 *   publishMs   publishDocument (version + checkpoint seal), mean of 5 updates
 *   indexMs     regenerateIndex after it, mean of the same 5
 *   crawlMs     one full discoverDocuments, for scale
 *   historyKB   .versions/context_history.yaml after the seed + 5 seals
 * Numbers are from local disk; a network-backed vault pays a round trip per file read.
 */
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { NestStorage, publishDocuments, publishDocument } = await import(
  pathToFileURL(join(here, "..", "packages", "engine", "dist", "index.js")).href
);

const UPDATES = 5;
const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);

for (const n of sizes.length ? sizes : [200, 1000, 3000]) {
  const dir = await mkdtemp(join(tmpdir(), "cn-bench-write-"));
  try {
    const storage = new NestStorage(dir);
    await storage.init("bench");
    const ids = [];
    for (let i = 0; i < n; i++) {
      const folder = `nodes/f${i % 20}`;
      await mkdir(join(dir, folder), { recursive: true });
      const id = `${folder}/doc-${i}`;
      ids.push(id);
      await writeFile(
        join(dir, `${id}.md`),
        `---\ntitle: Doc ${i}\ntype: document\ntags: [t${i % 7}]\n---\n\n# Doc ${i}\n\n[[Doc ${(i + 1) % n}]] ${"lorem ipsum ".repeat(200)}\n`,
      );
    }
    await publishDocuments(storage, ids, { editedBy: "bench" });

    let publishMs = 0;
    let indexMs = 0;
    for (let r = 0; r < UPDATES; r++) {
      const id = ids[r];
      const node = await storage.readDocument(id);
      await writeFile(join(dir, `${id}.md`), node.rawContent.replace("lorem", `edit${r}`));
      const t0 = performance.now();
      const res = await publishDocument(storage, id, { editedBy: "bench" });
      const t1 = performance.now();
      await storage.regenerateIndex({ changedIds: [id], latestCheckpoint: res.checkpoint, docs: res.vaultDocs, written: [res.node] });
      publishMs += t1 - t0;
      indexMs += performance.now() - t1;
    }

    const t = performance.now();
    await storage.discoverDocuments({ includeRetired: true });
    const crawlMs = performance.now() - t;
    const history = await stat(join(dir, ".versions", "context_history.yaml"));

    console.log(JSON.stringify({
      docs: n,
      publishMs: Math.round(publishMs / UPDATES),
      indexMs: Math.round(indexMs / UPDATES),
      crawlMs: Math.round(crawlMs),
      historyKB: Math.round(history.size / 1024),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
