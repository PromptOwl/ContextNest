import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapInBatches, VAULT_IO_CONCURRENCY } from "../concurrency.js";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapInBatches — sliding pool", () => {
  it("keeps input order and never exceeds the bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapInBatches(
      Array.from({ length: 20 }, (_, i) => i),
      async (i) => {
        peak = Math.max(peak, ++inFlight);
        await sleep((i * 7) % 5);
        inFlight--;
        return i * 2;
      },
      4,
    );
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(peak).toBe(4);
  });

  it("does not let one slow item hold the other slots", async () => {
    // Item 0 finishes only once every other item has. Fixed batches would wait
    // on item 0 before starting item 2 — a deadlock; a pool runs the rest
    // through the free slot.
    let fastDone = 0;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    await mapInBatches(
      Array.from({ length: 11 }, (_, i) => i),
      async (i) => {
        if (i === 0) return slow;
        await sleep(1);
        if (++fastDone === 10) release();
      },
      2,
    );
    expect(fastDone).toBe(10);
  });

  it("rejects on the first failure and starts nothing after it", async () => {
    const seen: number[] = [];
    await expect(
      mapInBatches(
        [0, 1, 2, 3, 4, 5],
        async (i) => {
          seen.push(i);
          if (i === 1) throw new Error("boom");
          await sleep(5);
        },
        2,
      ),
    ).rejects.toThrow("boom");
    await sleep(20);
    expect(seen).toEqual([0, 1]);
  });

  it("handles an empty list", async () => {
    expect(await mapInBatches([], async () => 1)).toEqual([]);
  });
});

describe("context_import — host-set ioConcurrency", () => {
  // Peak concurrent storage writes while importing 40 files.
  async function peakWrites(limits?: OperationContext["limits"]): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "contextnest-io-"));
    try {
      const storage = new NestStorage(dir);
      let inFlight = 0;
      let peak = 0;
      for (const name of ["writeVaultFile", "writeDocument"] as const) {
        const write = (storage[name] as (...a: unknown[]) => Promise<void>).bind(storage);
        (storage as any)[name] = async (...args: unknown[]) => {
          peak = Math.max(peak, ++inFlight);
          try {
            await sleep(2);
            return await write(...args);
          } finally {
            inFlight--;
          }
        };
      }
      const ctx: OperationContext = {
        storage,
        query: new GraphQueryEngine(storage),
        versions: new VersionManager(storage),
        actor: "tester@example.com",
        ...(limits ? { limits } : {}),
      };
      const files = Array.from({ length: 40 }, (_, i) => ({
        path: `nodes/doc-${i}.md`,
        content: `---\ntitle: Doc ${i}\ntype: document\n---\nbody ${i}\n`,
      }));
      const out = await createEngineApi().run<{ written?: number }>("context_import", { files, publish: false }, ctx);
      expect(out.written).toBe(40);
      return peak;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("keeps no more writes in flight than the host allows", async () => {
    const peak = await peakWrites({ ioConcurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("defaults to the vault I/O bound when the host sets none or an invalid value", async () => {
    for (const limits of [undefined, { ioConcurrency: 0 }, { ioConcurrency: Number.NaN }, { ioConcurrency: Infinity }]) {
      const peak = await peakWrites(limits);
      expect(peak, JSON.stringify(limits)).toBeLessThanOrEqual(VAULT_IO_CONCURRENCY);
      expect(peak, JSON.stringify(limits)).toBeGreaterThan(4);
    }
  });
});
