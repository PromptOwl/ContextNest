import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { CheckpointManager } from "../checkpoint.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { serializeDocument } from "../parser.js";
import type { CheckpointHistory } from "../types.js";

/**
 * The checkpoint chain grows by one entry per published document per
 * checkpoint, and every write used to read it whole, push one entry and dump it
 * back. On a mature vault that made each write cost O(chain size) — writes
 * timed out at 60s while reads, which never come through this path, stayed
 * instant.
 *
 * These cover the two halves of the fix from the outside: a write must not
 * depend on parsing the whole chain, and appending must produce exactly the
 * bytes a full rewrite would.
 */

const draft = (title: string): string =>
  `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n# ${title}\n\nbody\n`;

const HEADER = "# Auto-generated. Do not edit manually.\n";

describe("checkpoint chain — sealing appends instead of rewriting", () => {
  let root: string;
  let storage: NestStorage;
  let historyPath: string;

  /** Publish `count` revisions of one doc, sealing one checkpoint each. */
  async function sealCheckpoints(count: number, id = "nodes/doc"): Promise<void> {
    await storage.writeDocument(id, draft(id));
    for (let i = 0; i < count; i++) {
      const node = await storage.readDocument(id);
      node.body = `\n# doc\n\nrevision ${i}\n`;
      await storage.writeDocument(id, serializeDocument(node));
      await publishDocument(storage, id, { editedBy: "tester" });
    }
  }

  const readChain = async (): Promise<CheckpointHistory> =>
    yaml.load(await readFile(historyPath, "utf-8")) as CheckpointHistory;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cp-append-"));
    storage = new NestStorage(root);
    await storage.init("Append Checkpoint Vault");
    historyPath = join(root, ".versions", "context_history.yaml");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a chain byte-identical to what a full rewrite would produce", async () => {
    await sealCheckpoints(4);

    const onDisk = await readFile(historyPath, "utf-8");
    const rewritten =
      HEADER + yaml.dump(await readChain(), { lineWidth: -1, noRefs: true });

    expect(onDisk).toBe(rewritten);
  });

  it("numbers checkpoints consecutively across appends", async () => {
    await sealCheckpoints(5);

    const { checkpoints } = await readChain();
    expect(checkpoints.map((c) => c.checkpoint)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the chain verifiable after appending", async () => {
    await sealCheckpoints(4);

    const report = await storage.verifyVaultIntegrity();

    expect(report.errors.filter((e) => e.type.startsWith("checkpoint"))).toEqual([]);
  });

  it("only grows the file — earlier checkpoints keep their exact bytes", async () => {
    await sealCheckpoints(3);
    const before = await readFile(historyPath, "utf-8");

    await sealCheckpoints(1, "nodes/other");
    const after = await readFile(historyPath, "utf-8");

    expect(after.startsWith(before)).toBe(true);
  });

  it("queries without parsing the whole chain", async () => {
    // context_query is the hottest read path and stamps the checkpoint number
    // onto every trace it logs. Loading the chain for that one number made
    // retrieval pay the same O(chain size) cost the write path was freed from.
    await sealCheckpoints(3);
    storage.readCheckpointHistory = async () => {
      throw new Error("a query must not parse the whole checkpoint chain");
    };

    const engine = new GraphQueryEngine(storage);

    await expect(engine.query("#doc")).resolves.toBeTruthy();
  });

  it("still answers a query when the chain cannot be read at all", async () => {
    // Degrading the trace stamp beats failing someone's retrieval. The write
    // path takes the throwing read instead, where a transient failure has to
    // surface rather than be mistaken for "no chain".
    await sealCheckpoints(2);
    await rm(join(root, ".versions", "context_latest.yaml"), { force: true });
    await rm(historyPath, { force: true });
    await mkdir(historyPath, { recursive: true }); // forces a non-ENOENT error

    expect(await storage.readLatestCheckpointNumber()).toBe(0);

    const engine = new GraphQueryEngine(storage);
    await expect(engine.query("#doc")).resolves.toBeTruthy();
  });

  it("seals documents from nested folders and the vault root alike", async () => {
    // A document's history lives beside it, so the seal has to find
    // `<dir>/.versions/<name>/history.yaml` at any depth. A miss is silent —
    // the checkpoint just omits the document's chain hash, leaving it with no
    // integrity anchor while the publish still reports success.
    const ids = ["nodes/accounts/georgia/gta", "nodes/flat", "readme"];
    for (const id of ids) {
      await storage.writeDocument(id, draft(id));
      await publishDocument(storage, id, { editedBy: "tester" });
    }

    const head = (await storage.readLatestCheckpoint())!;

    for (const id of ids) {
      expect(head.document_versions).toHaveProperty([id]);
      expect(head.document_chain_hashes[id]).toMatch(/^sha256:/);
    }
  });

  it("publishes without parsing the whole chain", async () => {
    await sealCheckpoints(3);

    // The chain is the file that grows without bound. If the write path still
    // reads it whole, this publish fails — which is the regression to catch.
    storage.readCheckpointHistory = async () => {
      throw new Error("the write path must not parse the whole checkpoint chain");
    };

    await storage.writeDocument("nodes/fresh", draft("fresh"));
    const result = await publishDocument(storage, "nodes/fresh", {
      editedBy: "tester",
    });

    expect(result.checkpointNumber).toBe(4);

    // ...and so does the index regen every write runs afterwards, which wanted
    // the chain only to stamp the newest checkpoint into context.yaml.
    await storage.regenerateIndex();
    const contextYaml = yaml.load(
      await readFile(join(root, "context.yaml"), "utf-8"),
    ) as { checkpoint: number };
    expect(contextYaml.checkpoint).toBe(4);
  });
});

describe("checkpoint chain — a broken chain never blocks the write", () => {
  let root: string;
  let storage: NestStorage;
  let historyPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cp-broken-"));
    storage = new NestStorage(root);
    await storage.init("Broken Chain Vault");
    historyPath = join(root, ".versions", "context_history.yaml");
    await storage.writeDocument("nodes/seed", draft("seed"));
    await publishDocument(storage, "nodes/seed", { editedBy: "tester" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("publishes over an unreadable chain, preserving the old file", async () => {
    await writeFile(historyPath, "checkpoints:\n  - checkpoint: 1\0\0\0\n", "utf-8");

    await storage.writeDocument("nodes/next", draft("next"));
    await expect(
      publishDocument(storage, "nodes/next", { editedBy: "tester" }),
    ).resolves.toBeTruthy();

    // The unreadable bytes are moved aside, never overwritten.
    const quarantined = (await readdir(join(root, ".versions"))).filter((f) =>
      /^context_history\.corrupt-.*\.yaml$/.test(f),
    );
    expect(quarantined).toHaveLength(1);
    expect(
      await readFile(join(root, ".versions", quarantined[0]), "utf-8"),
    ).toContain("\0");

    // And the replacement chain is readable.
    const rebuilt = await storage.readCheckpointHistory();
    expect(rebuilt?.checkpoints).toHaveLength(1);
  });

  it("does not append into a chain file that holds an empty list", async () => {
    // What rebuildCheckpointHistory writes for a vault with nothing published.
    // Appending items after `checkpoints: []` would produce invalid YAML.
    await writeFile(historyPath, HEADER + "checkpoints: []\n", "utf-8");

    await storage.writeDocument("nodes/next", draft("next"));
    await publishDocument(storage, "nodes/next", { editedBy: "tester" });

    const chain = await storage.readCheckpointHistory();
    expect(chain?.checkpoints).toHaveLength(1);
  });

  it("does not call a valid-but-empty chain corrupt", async () => {
    // `checkpoints: []` is what a rebuild writes over a vault with nothing
    // published — valid YAML, zero entries. Quarantining it would litter the
    // vault with `.corrupt-*` files and cry a break that never happened.
    await writeFile(historyPath, HEADER + "checkpoints: []\n", "utf-8");
    expect(await storage.readCheckpointChainState()).toEqual({ kind: "empty" });

    await storage.writeDocument("nodes/next", draft("next"));
    await publishDocument(storage, "nodes/next", { editedBy: "tester" });

    expect(
      (await readdir(join(root, ".versions"))).filter((f) =>
        /corrupt/.test(f),
      ),
    ).toEqual([]);
  });

  it("tells the four chain states apart", async () => {
    // The whole point of the discriminated read: the seal quarantines on
    // exactly one of these, so collapsing any two of them into null is how a
    // healthy chain gets renamed aside.
    expect((await storage.readCheckpointChainState()).kind).toBe("head");

    await rm(historyPath, { force: true });
    expect(await storage.readCheckpointChainState()).toEqual({ kind: "absent" });

    await writeFile(historyPath, HEADER + "checkpoints: []\n", "utf-8");
    expect(await storage.readCheckpointChainState()).toEqual({ kind: "empty" });

    await writeFile(historyPath, "checkpoints:\n  - checkpoint: 1\0\0\0\n", "utf-8");
    expect((await storage.readCheckpointChainState()).kind).toBe("unreadable");
  });

  it("propagates a read error rather than reporting an absent chain", async () => {
    // A non-ENOENT failure is neither "no chain" nor "corrupt". Reported as
    // either one, it licenses a quarantine of a chain nobody has actually read.
    // A directory where the file belongs is the portable way to force one.
    await rm(historyPath, { force: true });
    await mkdir(historyPath, { recursive: true });

    await expect(storage.readCheckpointChainState()).rejects.toThrow();
  });

  it("fails loudly on a transient read error instead of discarding the chain", async () => {
    // The regression that matters most: readLatestCheckpoint used to swallow
    // every error, so one flaky read on a network-backed mount looked exactly
    // like "no chain yet" — and the seal would then quarantine a healthy
    // multi-megabyte chain and restart numbering at 1.
    await storage.writeDocument("nodes/two", draft("two"));
    await publishDocument(storage, "nodes/two", { editedBy: "tester" });
    const intact = await readFile(historyPath, "utf-8");

    const realStat = storage.readCheckpointChainState.bind(storage);
    let failNext = true;
    storage.readCheckpointChainState = async () => {
      if (failNext) {
        failNext = false;
        const err: NodeJS.ErrnoException = new Error("EIO: i/o error");
        err.code = "EIO";
        throw err;
      }
      return realStat();
    };

    await storage.writeDocument("nodes/three", draft("three"));
    await expect(
      publishDocument(storage, "nodes/three", { editedBy: "tester" }),
    ).rejects.toThrow(/EIO/);

    // The chain is untouched and nothing was quarantined.
    expect(await readFile(historyPath, "utf-8")).toBe(intact);
    expect(
      (await readdir(join(root, ".versions"))).filter((f) => /corrupt/.test(f)),
    ).toEqual([]);
  });

  it("ignores a pointer that no longer matches the chain on disk", async () => {
    // A restored backup / hand edit shortens the chain behind the cache's back.
    // The next seal must continue from the file, not from the stale pointer.
    await storage.writeDocument("nodes/two", draft("two"));
    await publishDocument(storage, "nodes/two", { editedBy: "tester" });
    await storage.writeDocument("nodes/three", draft("three"));
    await publishDocument(storage, "nodes/three", { editedBy: "tester" });

    const chain = (await storage.readCheckpointHistory())!;
    expect(chain.checkpoints).toHaveLength(3);

    // Truncate to two checkpoints WITHOUT going through writeCheckpointHistory,
    // so the pointer keeps naming checkpoint 3.
    await writeFile(
      historyPath,
      HEADER +
        yaml.dump({ checkpoints: chain.checkpoints.slice(0, 2) }, {
          lineWidth: -1,
          noRefs: true,
        }),
      "utf-8",
    );

    const sealed = await new CheckpointManager(storage).createCheckpointFromVault(
      "test",
    );

    expect(sealed.checkpoint).toBe(3);
    expect(sealed.document_chain_hashes).not.toEqual({});
  });

  it("recovers the head by tail-read when the pointer file is deleted", async () => {
    await storage.writeDocument("nodes/two", draft("two"));
    await publishDocument(storage, "nodes/two", { editedBy: "tester" });
    await rm(join(root, ".versions", "context_latest.yaml"), { force: true });

    const head = await storage.readLatestCheckpoint();

    expect(head?.checkpoint).toBe(2);
  });

  it("reads the head from a chain longer than the tail window", async () => {
    // The tail read looks at the last 64 KB. A chain past that must still
    // resolve its head, or a big vault silently restarts numbering at 1.
    const bulk: CheckpointHistory = { checkpoints: [] };
    const head = (await storage.readCheckpointHistory())!.checkpoints[0];
    for (let i = 1; i <= 400; i++) {
      bulk.checkpoints.push({
        ...head,
        checkpoint: i,
        document_versions: Object.fromEntries(
          Array.from({ length: 40 }, (_, d) => [`nodes/filler-${d}`, i]),
        ),
        document_chain_hashes: Object.fromEntries(
          Array.from({ length: 40 }, (_, d) => [`nodes/filler-${d}`, head.checkpoint_hash]),
        ),
      });
    }
    await writeFile(
      historyPath,
      HEADER + yaml.dump(bulk, { lineWidth: -1, noRefs: true }),
      "utf-8",
    );
    expect((await stat(historyPath)).size).toBeGreaterThan(64 * 1024);

    expect((await storage.readLatestCheckpoint())?.checkpoint).toBe(400);
  });
});
