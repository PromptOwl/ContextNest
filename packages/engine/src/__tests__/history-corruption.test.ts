import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { globFiles } from "../glob.js";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { CheckpointManager } from "../checkpoint.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { CorruptHistoryError, VersionArtifactExistsError } from "../errors.js";
import type { VersionEntry } from "../types.js";

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

describe("corrupt history.yaml — no version is lost or orphaned", () => {
  let root: string;
  let storage: NestStorage;
  const ID = "nodes/victim";

  /** Publish `count` successive revisions so there is real history to destroy. */
  async function buildHistory(count: number): Promise<void> {
    await storage.writeDocument(ID, draft(ID));
    for (let i = 0; i < count; i++) {
      const node = await storage.readDocument(ID);
      node.body = `\n# victim\n\nrevision ${i}\n`;
      await storage.writeDocument(ID, serializeDocument(node));
      await publishDocument(storage, ID, { editedBy: "tester" });
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-hist-loss-"));
    storage = new NestStorage(root);
    await storage.init("History Loss Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("publishes over a corrupt history by quarantining it, never by overwriting it", async () => {
    await buildHistory(4);
    const before = (await storage.readHistory(ID))!;
    const dir = join(root, "nodes", ".versions", "victim");
    const historyPath = join(dir, "history.yaml");
    await writeFile(historyPath, "versions:\n  - version: 1\0\0\0\n", "utf-8");

    // The author is not blocked: the write goes through.
    await expect(
      publishDocument(storage, ID, { editedBy: "tester" }),
    ).resolves.toBeTruthy();

    // The corrupt bytes still exist — moved aside, not destroyed.
    const quarantined = (await readdir(dir)).filter((f) =>
      /^history\.corrupt-.*\.yaml$/.test(f),
    );
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(dir, quarantined[0]), "utf-8")).toContain("\0");

    // The fresh chain is readable and starts ABOVE everything the old one
    // sealed, so no artifact was reused.
    const after = (await storage.readHistory(ID))!;
    expect(after.versions).toHaveLength(1);
    expect(after.versions[0].version).toBeGreaterThan(
      Math.max(...before.versions.map((v) => v.version)),
    );
    expect(after.versions[0].note).toMatch(/Chain restarted/);

    // And restoring the quarantined history makes every old version reachable.
    await storage.writeHistory(ID, before);
    const vm = new VersionManager(storage);
    for (const entry of before.versions) {
      await expect(vm.reconstructVersion(ID, entry.version)).resolves.toContain("---");
    }
  });

  it("records a draft revision over a corrupt history instead of refusing", async () => {
    // The Community edit path never publishes — it numbers a version and
    // records it. A corrupt history used to fail it the same way, leaving the
    // author unable to save the document from any surface.
    await buildHistory(3);
    await writeFile(
      join(root, "nodes", ".versions", "victim", "history.yaml"),
      "versions:\n  - version: 1\0\0\0\n",
      "utf-8",
    );

    const vm = new VersionManager(storage);
    const next = await vm.nextVersion(ID, 0);
    expect(next).toBeGreaterThan(3); // clears every sealed artifact

    const node = await storage.readDocument(ID);
    node.frontmatter.version = next;
    await expect(vm.createVersion(node, "author")).resolves.toMatchObject({
      version: next,
      keyframe: true,
    });
  });

  it("still publishes when the doc's current version is itself a sealed keyframe", async () => {
    // Regression: the pre-publish seed writes v{current}.md, and at a keyframe
    // boundary that file already exists — an exclusive create that threw and
    // put the author straight back behind the corrupt history.
    await buildHistory(11);
    expect(
      await globFiles(root, "nodes/.versions/victim/v11.md"),
    ).toHaveLength(1);
    await writeFile(
      join(root, "nodes", ".versions", "victim", "history.yaml"),
      "versions:\n  - version: 1\0\0\0\n",
      "utf-8",
    );

    await expect(
      publishDocument(storage, ID, { editedBy: "tester" }),
    ).resolves.toBeTruthy();
  });

  it("distinguishes a corrupt history from a document that has none", async () => {
    await storage.writeDocument("nodes/fresh", draft("fresh"));
    expect(await storage.readHistory("nodes/fresh")).toBeNull();

    await buildHistory(1);
    await writeFile(
      join(root, "nodes", ".versions", "victim", "history.yaml"),
      "versions: not-a-list\n",
      "utf-8",
    );
    await expect(storage.readHistory(ID)).rejects.toThrow(CorruptHistoryError);
  });

  it("keeps every keyframe and diff byte-identical when the chain restarts", async () => {
    await buildHistory(4);
    const artifactsBefore = await globFiles(root, "nodes/.versions/victim/v*");
    const hashesBefore = await Promise.all(
      artifactsBefore.sort().map((f) => readFile(join(root, f), "utf-8")),
    );

    await writeFile(
      join(root, "nodes", ".versions", "victim", "history.yaml"),
      "versions:\n  - version: 1\0\0\0\n",
      "utf-8",
    );
    await publishDocument(storage, ID, { editedBy: "tester" });

    // The restart may ADD artifacts above the old high-water mark, but every
    // one that was already sealed must survive untouched.
    const artifactsAfter = await globFiles(root, "nodes/.versions/victim/v*");
    expect(artifactsAfter.sort()).toEqual(
      expect.arrayContaining(artifactsBefore.sort()),
    );
    const hashesAfter = await Promise.all(
      artifactsBefore.sort().map((f) => readFile(join(root, f), "utf-8")),
    );
    expect(hashesAfter).toEqual(hashesBefore);
  });

  // A document's history lives beside it — `<dir>/.versions/<name>/` — so both
  // the quarantine and the on-disk high-water mark are derived from the id, not
  // from a fixed root. Nesting and root-level ids are the two ways that
  // derivation can go wrong, and getting it wrong restarts numbering at 1 and
  // collides with artifacts already sealed.
  it.each([
    ["a nested subfolder", "nodes/accounts/georgia/gta", "nodes/accounts/georgia"],
    ["a root-level document", "readme", "."],
  ])("restarts the chain correctly for %s", async (_label, id, dir) => {
    await storage.writeDocument(id, draft(id));
    for (let i = 0; i < 3; i++) {
      const node = await storage.readDocument(id);
      node.body = `\n# ${id}\n\nrevision ${i}\n`;
      await storage.writeDocument(id, serializeDocument(node));
      await publishDocument(storage, id, { editedBy: "tester" });
    }

    const versionsDir = join(root, dir, ".versions", basename(id));
    expect(await storage.maxRecordedVersion(id)).toBe(3);

    await writeFile(
      join(versionsDir, "history.yaml"),
      "versions:\n  - version: 1\0\0\0\n",
      "utf-8",
    );

    await expect(
      publishDocument(storage, id, { editedBy: "tester" }),
    ).resolves.toBeTruthy();

    // Quarantined next to the document it belongs to, not at the vault root.
    expect(
      (await readdir(versionsDir)).filter((f) =>
        /^history\.corrupt-.*\.yaml$/.test(f),
      ),
    ).toHaveLength(1);

    // Numbering cleared every sealed artifact, so none was reused.
    const restarted = (await storage.readHistory(id))!;
    expect(restarted.versions[0].version).toBeGreaterThan(3);
    expect(restarted.versions[0].note).toMatch(/Chain restarted/);
  });

  it("refuses to overwrite a sealed version artifact", async () => {
    await buildHistory(2);
    const keyframePath = join(root, "nodes", ".versions", "victim", "v1.md");
    const sealed = await readFile(keyframePath, "utf-8");

    await expect(
      storage.writeKeyframe(ID, 1, "REPLACEMENT CONTENT"),
    ).rejects.toThrow(VersionArtifactExistsError);
    expect(await readFile(keyframePath, "utf-8")).toBe(sealed);

    // The repair paths opt in explicitly and are still allowed through.
    await storage.writeKeyframe(ID, 1, "REPLACEMENT CONTENT", { overwrite: true });
    expect(await readFile(keyframePath, "utf-8")).toBe("REPLACEMENT CONTENT");
  });
});

describe("recording a version appends — it never rewrites what is on disk", () => {
  let root: string;
  let storage: NestStorage;
  const ID = "nodes/appended";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-hist-append-"));
    storage = new NestStorage(root);
    await storage.init("Append Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const historyPath = () =>
    join(root, "nodes", ".versions", "appended", "history.yaml");

  async function publishRevision(label: string): Promise<void> {
    const node = await storage.readDocument(ID);
    node.body = `\n# appended\n\n${label}\n`;
    await storage.writeDocument(ID, serializeDocument(node));
    await publishDocument(storage, ID, { editedBy: "tester" });
  }

  it("leaves the existing bytes untouched and only grows the file", async () => {
    await storage.writeDocument(ID, draft(ID));
    await publishDocument(storage, ID, { editedBy: "tester" });
    await publishRevision("second");
    const before = await readFile(historyPath(), "utf-8");

    await publishRevision("third");
    const after = await readFile(historyPath(), "utf-8");

    // The whole prior file is a byte-exact PREFIX of the new one. That is the
    // structural guarantee: earlier versions cannot be dropped or altered,
    // because those bytes are never reopened for writing.
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("writes the file header exactly once", async () => {
    await storage.writeDocument(ID, draft(ID));
    await publishDocument(storage, ID, { editedBy: "tester" });
    await publishRevision("second");
    await publishRevision("third");

    const raw = await readFile(historyPath(), "utf-8");
    expect(raw.match(/^versions:$/gm)).toHaveLength(1);
    expect(raw.match(/^keyframe_interval:/gm)).toHaveLength(1);

    const history = (await storage.readHistory(ID))!;
    expect(history.versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("keeps `versions` last when rewriting, so the list stays open for appends", async () => {
    // writeHistory is the mutating path (repairs). If it ever emitted another
    // key after `versions`, the next append would land outside the list and
    // produce invalid YAML — so the ordering is a hard precondition, not style.
    await storage.writeDocument(ID, draft(ID));
    await publishDocument(storage, ID, { editedBy: "tester" });

    const history = (await storage.readHistory(ID))!;
    await storage.writeHistory(ID, history);
    const raw = await readFile(historyPath(), "utf-8");
    expect(raw.trimEnd().split("\n").at(0)).toMatch(/^keyframe_interval:/);
    expect(raw).toMatch(/^versions:$/m);

    // And an append on top of a rewritten file still round-trips.
    await publishRevision("after rewrite");
    const reread = (await storage.readHistory(ID))!;
    expect(reread.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("writes exactly one header when first-time appends race on the same file", async () => {
    // Deciding the header from an observed file size is a check-then-act race:
    // concurrent first appends each see an empty file and each prepend a header,
    // producing two `versions:` keys and an unparseable history. At this width
    // the pre-fix code corrupted ~70% of the documents, every run.
    const entry = (version: number): VersionEntry => ({
      version,
      keyframe: true,
      edited_by: "tester",
      edited_at: "2026-01-01T00:00:00.000Z",
      content_hash: `sha256:${"a".repeat(64)}`,
      chain_hash: `sha256:${"b".repeat(64)}`,
    });

    const ids = Array.from({ length: 60 }, (_, i) => `nodes/hdr-${i}`);
    await Promise.all(
      ids.flatMap((id) => [
        storage.appendVersionEntry(id, entry(1), 10),
        storage.appendVersionEntry(id, entry(2), 10),
        storage.appendVersionEntry(id, entry(3), 10),
      ]),
    );

    for (const id of ids) {
      const raw = await readFile(
        join(root, "nodes", ".versions", id.split("/")[1], "history.yaml"),
        "utf-8",
      );
      expect(raw.match(/^versions:$/gm)).toHaveLength(1);
      const history = await storage.readHistory(id);
      expect(history?.versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
    }
  });

  it("does not lose entries when several versions are recorded concurrently", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `nodes/conc-${i}`);
    for (const id of ids) await storage.writeDocument(id, draft(id));
    await Promise.all(
      ids.map((id) => publishDocument(storage, id, { editedBy: "tester" })),
    );

    for (const id of ids) {
      const history = await storage.readHistory(id);
      expect(history?.versions.map((v) => v.version)).toEqual([1]);
    }
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
    const strays = await globFiles(root, "**/*.tmp", [], true);
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
    expect(await globFiles(root, "**/*.tmp", [], true)).toEqual([]);
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
    expect(await globFiles(root, "**/*.tmp", [], true)).toEqual([]);
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
