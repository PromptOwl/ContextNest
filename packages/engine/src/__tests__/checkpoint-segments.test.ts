import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { CheckpointManager } from "../checkpoint.js";
import { computeCheckpointHash } from "../integrity.js";
import { serializeDocument } from "../parser.js";
import type { CheckpointHistory } from "../types.js";

/**
 * The chain used to be one `context_history.yaml` that every seal appended a
 * whole checkpoint to — every published document's version and chain hash. On
 * a GCS-mounted vault an append re-uploads the whole object, so in a 340-doc
 * vault each write spent ~4.5 s rewriting a 350 MB file.
 *
 * Now a seal appends a delta (only what changed) to the newest of a run of
 * bounded segment files under `.versions/.checkpoints/`, each opening with one
 * whole checkpoint. These pin that down from the outside: the file a seal
 * writes stays the same size however long the chain gets, a legacy single-file
 * chain still reads and verifies and is never rewritten, and a chain spanning
 * segments verifies and catches tampering in any of them.
 */

const HEADER = "# Auto-generated. Do not edit manually.\n";

const draft = (title: string): string =>
  `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n# ${title}\n\nbody\n`;

describe("checkpoint chain — bounded segments of deltas", () => {
  let root: string;
  let storage: NestStorage;
  let segDir: string;
  let legacyPath: string;
  let revision = 0;

  const open = (checkpointsPerSegment?: number) => {
    storage = new NestStorage(root, { checkpointsPerSegment });
  };

  async function publishNew(id: string): Promise<void> {
    await storage.writeDocument(id, draft(id));
    await publishDocument(storage, id, { editedBy: "tester" });
  }

  /** Publish a new revision of `id` — one sealed checkpoint. */
  async function revise(id = "nodes/doc"): Promise<void> {
    const node = await storage.readDocument(id);
    node.body = `\n# doc\n\nrevision ${++revision}\n`;
    await storage.writeDocument(id, serializeDocument(node));
    await publishDocument(storage, id, { editedBy: "tester" });
  }

  const segments = async (): Promise<string[]> =>
    (await readdir(segDir)).filter((f) => /^\d+\.yaml$/.test(f)).sort();

  const segmentEntries = async (file: string): Promise<Array<Record<string, unknown>>> =>
    (yaml.load(await readFile(join(segDir, file), "utf-8")) as { checkpoints: Array<Record<string, unknown>> }).checkpoints;

  const checkpointErrors = async () =>
    (await storage.verifyVaultIntegrity()).errors.filter((e) => e.type.startsWith("checkpoint"));

  /** Turn the vault's chain into what an older engine left: one context_history.yaml. */
  async function toLegacy(): Promise<CheckpointHistory> {
    const history = (await storage.readCheckpointHistory())!;
    await writeFile(legacyPath, HEADER + yaml.dump(history, { lineWidth: -1, noRefs: true }), "utf-8");
    await rm(segDir, { recursive: true, force: true });
    // ...and the pointer it wrote: no `history_file`, stamped with that file.
    const s = await stat(legacyPath);
    await writeFile(
      join(root, ".versions", "context_latest.yaml"),
      yaml.dump({ history_bytes: s.size, history_mtime_ms: s.mtimeMs, checkpoint: history.checkpoints.at(-1) }),
      "utf-8",
    );
    return history;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cp-segments-"));
    open();
    await storage.init("Segmented Chain Vault");
    segDir = join(root, ".versions", ".checkpoints");
    legacyPath = join(root, ".versions", "context_history.yaml");
    revision = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("appends only what changed, however many documents are published", async () => {
    for (let i = 0; i < 40; i++) await publishNew(`nodes/filler-${i}`);
    await publishNew("nodes/doc");
    const [file] = await segments();
    const before = (await stat(join(segDir, file))).size;

    await revise();

    const appended = (await stat(join(segDir, file))).size - before;
    const head = (await storage.readLatestCheckpoint())!;
    const whole = yaml.dump(head, { lineWidth: -1 }).length;
    expect(Object.keys(head.document_versions)).toHaveLength(41);
    expect(appended).toBeLessThan(1024);
    expect(appended * 5).toBeLessThan(whole);
  });

  it("keeps the file each seal writes the same size as the chain grows", async () => {
    open(4);
    for (let i = 0; i < 20; i++) await publishNew(`nodes/filler-${i}`);
    await publishNew("nodes/doc");
    const sizes: number[] = [];
    for (let i = 0; i < 40; i++) {
      await revise();
      const newest = (await segments()).at(-1)!;
      sizes.push((await stat(join(segDir, newest))).size);
    }

    // Five times the chain, and the file a seal rewrites is no bigger (give or
    // take version numbers gaining a digit). One file took every seal before,
    // so this ratio was the chain's growth: about 5x here.
    expect(Math.max(...sizes.slice(20))).toBeLessThan(Math.max(...sizes.slice(0, 8)) * 1.1);
    for (const file of await segments()) {
      expect((await segmentEntries(file)).length).toBeLessThanOrEqual(4);
    }
    expect(await checkpointErrors()).toEqual([]);
  });

  it("never rewrites a segment once a newer one exists", async () => {
    open(3);
    await publishNew("nodes/doc");
    for (let i = 0; i < 3; i++) await revise(); // checkpoints 1-4: segments 1 and 4
    const first = await readFile(join(segDir, "000000001.yaml"), "utf-8");

    for (let i = 0; i < 4; i++) await revise();

    expect(await readFile(join(segDir, "000000001.yaml"), "utf-8")).toBe(first);
    expect(await segments()).toEqual(["000000001.yaml", "000000004.yaml", "000000007.yaml"]);
  });

  it("writes segments byte-identical to what one full write of them would produce", async () => {
    // The append trick: a delta item appended under `checkpoints:` must be
    // exactly what encoding the whole segment at once would emit.
    open(5);
    await publishNew("nodes/doc");
    await publishNew("nodes/other");
    for (let i = 0; i < 3; i++) await revise();
    const [file] = await segments();
    const onDisk = await readFile(join(segDir, file), "utf-8");

    await storage.writeCheckpointHistory((await storage.readCheckpointHistory())!);

    expect(await readFile(join(segDir, file), "utf-8")).toBe(onDisk);
  });

  describe("a legacy context_history.yaml", () => {
    it("still reads and verifies", async () => {
      await publishNew("nodes/doc");
      for (let i = 0; i < 3; i++) await revise();
      await toLegacy();

      expect((await storage.readCheckpointHistory())?.checkpoints.map((c) => c.checkpoint)).toEqual([1, 2, 3, 4]);
      expect(await checkpointErrors()).toEqual([]);
      // Its head, from the old-style pointer and then from a tail read.
      expect((await storage.readCheckpointChainState())).toMatchObject({ kind: "head", checkpoint: { checkpoint: 4 } });
      await rm(join(root, ".versions", "context_latest.yaml"));
      const state = await storage.readCheckpointChainState();
      expect(state).toMatchObject({ kind: "head", checkpoint: { checkpoint: 4 } });
      expect(state).not.toHaveProperty("segment");
    });

    it("migrates on the next seal without being rewritten", async () => {
      await publishNew("nodes/doc");
      for (let i = 0; i < 3; i++) await revise();
      await toLegacy();
      const legacy = await readFile(legacyPath, "utf-8");

      await publishNew("nodes/second");
      await revise();

      expect(await readFile(legacyPath, "utf-8")).toBe(legacy);
      expect(await segments()).toEqual(["000000005.yaml"]);
      const [opening] = await segmentEntries("000000005.yaml");
      expect(opening).toHaveProperty("document_versions"); // a segment opens whole
      const chain = (await storage.readCheckpointHistory())!.checkpoints;
      expect(chain.map((c) => c.checkpoint)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(chain[5].document_versions).toEqual({ "nodes/doc": 5, "nodes/second": 1 });
      // The link from the legacy file into the first segment verifies too.
      expect(await checkpointErrors()).toEqual([]);
    });

    it("is replaced by a rebuild, which writes segments", async () => {
      await publishNew("nodes/doc");
      await toLegacy();
      await publishNew("nodes/second"); // legacy + one segment

      const rebuilt = await new CheckpointManager(storage).rebuildCheckpointHistory();

      await expect(stat(legacyPath)).rejects.toThrow();
      expect(await segments()).toEqual(["000000001.yaml"]);
      expect((await storage.readCheckpointHistory())?.checkpoints).toEqual(rebuilt.checkpoints);
      expect(await checkpointErrors()).toEqual([]);
    });
  });

  describe("a chain spanning segments", () => {
    beforeEach(async () => {
      open(3);
      await publishNew("nodes/doc");
      await publishNew("nodes/other");
      for (let i = 0; i < 6; i++) await revise(); // checkpoints 1-8: segments 1, 4, 7
    });

    /** Rewrite one segment's entries through `edit`. */
    async function tamper(file: string, edit: (entries: Array<Record<string, any>>) => void): Promise<void> {
      const entries = await segmentEntries(file);
      edit(entries);
      await writeFile(join(segDir, file), HEADER + yaml.dump({ checkpoints: entries }, { lineWidth: -1 }), "utf-8");
    }

    const mismatched = async () =>
      (await checkpointErrors()).filter((e) => e.type === "checkpoint_hash_mismatch").map((e) => e.checkpoint);

    it("verifies", async () => {
      expect(await segments()).toEqual(["000000001.yaml", "000000004.yaml", "000000007.yaml"]);
      expect(await checkpointErrors()).toEqual([]);
      const chain = (await storage.readCheckpointHistory())!.checkpoints;
      expect(chain.map((c) => c.checkpoint)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(chain[7].document_versions).toEqual({ "nodes/doc": 7, "nodes/other": 1 });
    });

    it("catches an edited delta", async () => {
      await tamper("000000004.yaml", (e) => {
        e[1].changed_versions["nodes/doc"] = 99;
      });
      expect(await mismatched()).toContain(5);
    });

    it("catches an edited opening checkpoint", async () => {
      await tamper("000000007.yaml", (e) => {
        e[0].document_versions["nodes/other"] = 2;
      });
      expect(await mismatched()).toContain(7);
    });

    it("catches an edit whose own hash was recomputed, at the next link", async () => {
      await tamper("000000004.yaml", (e) => {
        const prev = e[0];
        const forged = { ...prev.document_chain_hashes, "nodes/other": `sha256:${"0".repeat(64)}` };
        e[0] = {
          ...prev,
          document_chain_hashes: forged,
          checkpoint_hash: computeCheckpointHash(
            null, // the forger does not know (or ignores) checkpoint 3's hash
            prev.checkpoint,
            prev.at,
            prev.triggered_by,
            prev.document_versions,
            forged,
          ),
        };
      });
      expect(await mismatched()).toContain(4);
    });

    it("catches a missing segment", async () => {
      await rm(join(segDir, "000000004.yaml"));
      expect(await mismatched()).toEqual([7]);
    });

    it("finds the head in the newest segment without the pointer", async () => {
      await rm(join(root, ".versions", "context_latest.yaml"));
      expect(await storage.readCheckpointChainState()).toMatchObject({
        kind: "head",
        segment: 7,
        checkpoint: { checkpoint: 8, document_versions: { "nodes/doc": 7, "nodes/other": 1 } },
      });
    });

    it("ignores a pointer that names an older segment", async () => {
      // A seal that rolled to a new segment and died before re-pointing.
      const older = join(segDir, "000000004.yaml");
      const s = await stat(older);
      const chain = (await storage.readCheckpointHistory())!.checkpoints;
      await writeFile(
        join(root, ".versions", "context_latest.yaml"),
        yaml.dump({ history_file: ".checkpoints/000000004.yaml", history_bytes: s.size, history_mtime_ms: s.mtimeMs, checkpoint: chain[5] }),
        "utf-8",
      );

      const sealed = await new CheckpointManager(storage).createCheckpointFromVault("test");

      expect(sealed.checkpoint).toBe(9);
      expect(await checkpointErrors()).toEqual([]);
    });

    it("quarantines the whole chain when the newest segment is unreadable", async () => {
      await writeFile(join(segDir, "000000007.yaml"), "checkpoints:\n  - checkpoint: 7\0\0\0\n", "utf-8");
      await rm(join(root, ".versions", "context_latest.yaml"));
      expect((await storage.readCheckpointChainState()).kind).toBe("unreadable");

      await revise();

      const aside = (await readdir(join(root, ".versions"))).filter((f) => f.startsWith(".checkpoints.corrupt-"));
      expect(aside).toHaveLength(1);
      expect((await readdir(join(root, ".versions", aside[0]))).sort()).toEqual([
        "000000001.yaml",
        "000000004.yaml",
        "000000007.yaml",
      ]);
      expect((await storage.readCheckpointHistory())?.checkpoints.map((c) => c.checkpoint)).toEqual([1]);
    });
  });
});
