import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fg from "fast-glob";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { CheckpointManager } from "../checkpoint.js";

/**
 * Regression tests for the corrupt-history crash surfaced while dogfooding:
 *
 *   `ctx publish` threw `YAMLException: null byte is not allowed in input`
 *   from inside findAllHistories — a single zero-filled history.yaml (the
 *   residue of an interrupted, non-atomic write) aborted the whole crawl and
 *   with it the checkpoint seal, `ctx verify` and the §7.3 rebuild.
 *
 * The fix has two halves, one per describe block: don't crash on a corrupt
 * file (but don't silently pass it either), and don't produce one in the first
 * place.
 */

const draft = (title: string): string =>
  `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n# ${title}\n\nbody\n`;

/** Zero-filled history.yaml — what an interrupted write leaves behind. */
async function writeCorruptHistory(root: string, docId: string): Promise<void> {
  const dir = join(root, "nodes", ".versions", docId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "history.yaml"),
    `versions:\n  - version: 1\0\0\0\n`,
    "utf-8",
  );
}

describe("corrupt history.yaml — crawl survives and reports", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-hist-corrupt-"));
    storage = new NestStorage(root);
    await storage.init("Corrupt History Vault");
    await storage.writeDocument("nodes/ok", draft("ok"));
    await publishDocument(storage, "nodes/ok", { editedBy: "tester" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips a null-byte history instead of throwing YAMLException", async () => {
    await writeCorruptHistory(root, "broken");

    const histories = await storage.findAllHistories();

    expect(histories.has("nodes/ok")).toBe(true);
    expect(histories.has("nodes/broken")).toBe(false);
  });

  it("reports the corrupt file to onUnreadable rather than dropping it silently", async () => {
    await writeCorruptHistory(root, "broken");

    const seen: string[] = [];
    await storage.findAllHistories((docId) => seen.push(docId));

    expect(seen).toEqual(["nodes/broken"]);
  });

  it("reports a schema-invalid history too — it is equally unverifiable", async () => {
    const dir = join(root, "nodes", ".versions", "bad-schema");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "history.yaml"), "versions: not-a-list\n", "utf-8");

    const seen: string[] = [];
    await storage.findAllHistories((docId) => seen.push(docId));

    expect(seen).toEqual(["nodes/bad-schema"]);
  });

  it("fails verifyVaultIntegrity instead of passing green on an unverifiable doc", async () => {
    await writeCorruptHistory(root, "broken");

    const report = await storage.verifyVaultIntegrity();

    expect(report.valid).toBe(false);
    expect(
      report.errors.filter((e) => e.type === "unreadable_history"),
    ).toHaveLength(1);
    expect(
      report.errors.find((e) => e.type === "unreadable_history")?.document,
    ).toBe("nodes/broken");
  });

  it("still publishes and seals a checkpoint with a corrupt history present", async () => {
    await writeCorruptHistory(root, "broken");

    await storage.writeDocument("nodes/next", draft("next"));
    const result = await publishDocument(storage, "nodes/next", {
      editedBy: "tester",
    });

    expect(result.checkpointNumber).toBeGreaterThan(0);
  });

  it("still rebuilds the checkpoint history with a corrupt history present", async () => {
    await writeCorruptHistory(root, "broken");

    const rebuilt = await new CheckpointManager(storage).rebuildCheckpointHistory();

    expect(rebuilt.checkpoints.length).toBeGreaterThan(0);
  });
});

describe("history writes are durable (no torn file to begin with)", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-hist-durable-"));
    storage = new NestStorage(root);
    await storage.init("Durable History Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("leaves no .tmp residue and a parseable history after publish", async () => {
    await storage.writeDocument("nodes/d", draft("d"));
    await publishDocument(storage, "nodes/d", { editedBy: "tester" });

    const historyPath = join(root, "nodes", ".versions", "d", "history.yaml");
    const content = await readFile(historyPath, "utf-8");
    expect(content).not.toContain("\0");

    // Every temp must be renamed away, not left beside the real file.
    const strays = await fg("**/*.tmp", { cwd: root, dot: true });
    expect(strays).toEqual([]);
  });

  it("does not throw when concurrent writers target the same history file", async () => {
    // A shared `{path}.tmp` would collide here: both writers truncate the same
    // temp, the first rename consumes it, the second fails ENOENT. The same
    // overlap is reachable in production on context_history.yaml, which
    // rebuildCheckpointHistory writes outside withCheckpointLock.
    await storage.writeDocument("nodes/race", draft("race"));
    await publishDocument(storage, "nodes/race", { editedBy: "tester" });
    const history = (await storage.readHistory("nodes/race"))!;

    await Promise.all(
      Array.from({ length: 8 }, () => storage.writeHistory("nodes/race", history)),
    );

    expect(await storage.readHistory("nodes/race")).toEqual(history);
    expect(await fg("**/*.tmp", { cwd: root, dot: true })).toEqual([]);
  });

  it("keeps a concurrent rebuild and publish from tearing context_history.yaml", async () => {
    for (const id of ["nodes/r1", "nodes/r2"]) {
      await storage.writeDocument(id, draft(id));
      await publishDocument(storage, id, { editedBy: "tester" });
    }

    const cm = new CheckpointManager(storage);
    await storage.writeDocument("nodes/r3", draft("r3"));
    await Promise.all([
      cm.rebuildCheckpointHistory(),
      publishDocument(storage, "nodes/r3", { editedBy: "tester" }),
    ]);

    // Whichever write landed last, the file must be intact and parseable.
    expect(await storage.readCheckpointHistory()).not.toBeNull();
    expect(await fg("**/*.tmp", { cwd: root, dot: true })).toEqual([]);
  });

  it("hides temp files from the history crawl even mid-write", async () => {
    await storage.writeDocument("nodes/g", draft("g"));
    await publishDocument(storage, "nodes/g", { editedBy: "tester" });

    // Simulate a temp left by a crashed write: the crawl must ignore it rather
    // than treat it as a second history for the document.
    await writeFile(
      join(root, "nodes", ".versions", "g", "history.yaml.1.1.tmp"),
      "garbage: [\0",
      "utf-8",
    );

    const histories = await storage.findAllHistories();
    expect([...histories.keys()]).toEqual(["nodes/g"]);
  });
});
