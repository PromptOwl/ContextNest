/**
 * Version chain integrity — history.yaml is append-only.
 *
 * Two guarantees covered here:
 *  1. A new version always outranks every version already in history, even when
 *     the document's frontmatter lags it (imported/copied vault, restored
 *     backup). Numbering from frontmatter alone grafted a SECOND chain onto the
 *     first — duplicate v{N} entries, keyframe files overwritten at the same
 *     number, reconstructVersion() failing on the first diff after the graft.
 *  2. A chain that can no longer be reconstructed self-heals: the next version
 *     is written as a keyframe instead of an unusable diff, so reads work again
 *     from that version forward.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { serializeDocument } from "../parser.js";
import { VersionManager } from "../versioning.js";
import { publishDocument } from "../publish.js";
import type { ContextNode } from "../types.js";

const DOC_ID = "nodes/demo";

function node(version: number, body: string): ContextNode {
  return {
    id: DOC_ID,
    filePath: "",
    rawContent: "",
    frontmatter: { title: "demo", type: "document", status: "published", version },
    body,
  };
}

describe("version chain integrity", () => {
  let storage: NestStorage;
  let versions: VersionManager;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-chain-"));
    storage = new NestStorage(dir);
    versions = new VersionManager(storage);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Append versions 1..n through the VersionManager, one edit each. */
  async function buildChain(n: number): Promise<void> {
    for (let v = 1; v <= n; v++) {
      const doc = node(v, `body line ${v}`);
      await storage.writeDocument(DOC_ID, serializeDocument(doc));
      await versions.createVersion(await storage.readDocument(DOC_ID), "me@x.io");
    }
  }

  it("stores keyframes as v{N}.md and every other version as a v{N}.diff change log", async () => {
    await buildChain(22);

    const files = await readdir(join(dir, "nodes/.versions/demo"));
    const keyframes = [1, 11, 21];

    // A file per version: full snapshot at a keyframe, change log otherwise.
    for (let v = 1; v <= 22; v++) {
      const expected = keyframes.includes(v) ? `v${v}.md` : `v${v}.diff`;
      expect(files, `v${v} should be stored as ${expected}`).toContain(expected);
    }
    // No full snapshot for a non-keyframe version — that is the duplication
    // this layout exists to avoid.
    for (let v = 1; v <= 22; v++) {
      if (keyframes.includes(v)) continue;
      expect(files, `v${v} must not store a full snapshot`).not.toContain(`v${v}.md`);
    }
    expect(files).toContain("history.yaml");

    const history = (await storage.readHistory(DOC_ID))!;
    expect(history.versions.filter((e) => e.keyframe).map((e) => e.version)).toEqual(
      keyframes,
    );
    // history.yaml is metadata only — no patch bytes inline on any entry.
    for (const entry of history.versions) {
      expect(entry.diff, `v${entry.version} should not inline its patch`).toBeUndefined();
    }
    // And the change log is retrievable per version, keyframes excepted.
    await expect(versions.getDiff(DOC_ID, 4)).resolves.toContain("@@");
    await expect(versions.getDiff(DOC_ID, 11)).resolves.toBeNull();
  });

  it("reconstructs every version byte-identical to what was written", async () => {
    const written: string[] = [];
    for (let v = 1; v <= 22; v++) {
      const doc = node(v, `body line ${v}`);
      await storage.writeDocument(DOC_ID, serializeDocument(doc));
      const parsed = await storage.readDocument(DOC_ID);
      written.push(serializeDocument(parsed));
      await versions.createVersion(parsed, "me@x.io");
    }

    for (let v = 1; v <= 22; v++) {
      await expect(versions.reconstructVersion(DOC_ID, v)).resolves.toBe(written[v - 1]);
    }
  });

  it("nextVersion outranks the recorded history when frontmatter lags it", async () => {
    await buildChain(3);

    // Imported doc: history says 3, the copied markdown says 1.
    await expect(versions.nextVersion(DOC_ID, 1)).resolves.toBe(4);
    // Frontmatter ahead of history still wins.
    await expect(versions.nextVersion(DOC_ID, 9)).resolves.toBe(10);
    // No history at all — fall back to the hint.
    await expect(versions.nextVersion("nodes/absent", 0)).resolves.toBe(1);
  });

  it("publish never reuses a version number when frontmatter lags history", async () => {
    await buildChain(3);

    // Simulate the import: history is intact, the on-disk file's frontmatter
    // was reset to 1 (previously-exported vault, half-migrated doc).
    await storage.writeDocument(DOC_ID, serializeDocument(node(1, "imported body")));

    const { versionEntry } = await publishDocument(storage, DOC_ID, {
      editedBy: "importer@x.io",
      note: "Imported from existing folder",
    });
    expect(versionEntry.version).toBe(4);

    const history = (await storage.readHistory(DOC_ID))!;
    const numbers = history.versions.map((e) => e.version);
    expect(numbers).toEqual([1, 2, 3, 4]);
    expect(new Set(numbers).size).toBe(numbers.length);

    // The whole chain still rebuilds, including the version added on import.
    for (const v of numbers) {
      await expect(versions.reconstructVersion(DOC_ID, v)).resolves.toContain("---");
    }
  });

  it("falls back to a keyframe when the previous version cannot be rebuilt", async () => {
    await buildChain(3);

    // Corrupt the chain the way a grafted history did: make v2's change log
    // unusable against the version it claims to follow.
    const patch = (await versions.getDiff(DOC_ID, 2))!;
    await storage.writeDiff(
      DOC_ID,
      2,
      patch.replace("body line 1", "text that is not in v1"),
    );
    await expect(versions.reconstructVersion(DOC_ID, 3)).rejects.toThrow();

    // Next edit must still be storable, and readable afterwards.
    const doc = node(4, "body line 4");
    await storage.writeDocument(DOC_ID, serializeDocument(doc));
    const entry = await versions.createVersion(
      await storage.readDocument(DOC_ID),
      "me@x.io",
    );

    expect(entry.keyframe).toBe(true);
    expect(entry.diff).toBeUndefined();
    await expect(versions.reconstructVersion(DOC_ID, 4)).resolves.toContain(
      "body line 4",
    );
  });

  it("repairLatestVersion re-anchors a grafted chain without adding a version", async () => {
    await buildChain(3);

    // Graft a second chain on, exactly as an import with a copied .versions/
    // folder used to: version numbers restart and overwrite live ones.
    const grafted = (await storage.readHistory(DOC_ID))!;
    grafted.versions = [...grafted.versions, ...grafted.versions.map((e) => ({ ...e }))];
    await storage.writeHistory(DOC_ID, grafted);
    await expect(versions.reconstructVersion(DOC_ID, 3)).rejects.toThrow();

    await expect(versions.repairLatestVersion(DOC_ID)).resolves.toBe(true);

    const after = (await storage.readHistory(DOC_ID))!;
    // Nothing renumbered, nothing added — the chain is the prefix up to its
    // highest version, with the graft tail that re-trod 1..3 dropped.
    expect(after.versions.map((e) => e.version)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(after.versions.at(-1)!.version).toBe(3);
    // The current version reads again.
    await expect(versions.reconstructVersion(DOC_ID, 3)).resolves.toContain(
      "body line 3",
    );
    // And it is a no-op on a chain that already reconstructs.
    await expect(versions.repairLatestVersion(DOC_ID)).resolves.toBe(false);
  });

  it("repairLatestVersion drops a graft tail recorded after the highest version", async () => {
    await buildChain(4);

    // Re-import graft: numbers restart, so the tail sits AFTER v4 in the file
    // and its stale v1 keyframe would win reconstruct's nearest-keyframe scan.
    const grafted = (await storage.readHistory(DOC_ID))!;
    const tail = grafted.versions.slice(0, 2).map((e) => ({ ...e }));
    grafted.versions = [...grafted.versions, ...tail];
    await storage.writeHistory(DOC_ID, grafted);
    await expect(versions.reconstructVersion(DOC_ID, 4)).rejects.toThrow();

    await expect(versions.repairLatestVersion(DOC_ID)).resolves.toBe(true);

    const after = (await storage.readHistory(DOC_ID))!;
    expect(after.versions.map((e) => e.version)).toEqual([1, 2, 3, 4]);
    expect(after.versions.at(-1)!.keyframe).toBe(true);
    await expect(versions.reconstructVersion(DOC_ID, 4)).resolves.toContain(
      "body line 4",
    );
  });

  it("still reconstructs a history that stores its patches inline (pre-migration)", async () => {
    await buildChain(4);

    // Rewrite the chain in the old shape: patch inline on the entry, no file.
    const history = (await storage.readHistory(DOC_ID))!;
    for (const entry of history.versions) {
      if (entry.keyframe) continue;
      entry.diff = (await storage.readDiff(DOC_ID, entry.version))!;
      await rm(join(dir, `nodes/.versions/demo/v${entry.version}.diff`));
    }
    await storage.writeHistory(DOC_ID, history);

    for (let v = 1; v <= 4; v++) {
      await expect(versions.reconstructVersion(DOC_ID, v)).resolves.toContain(
        `body line ${v}`,
      );
    }
    // The per-version change log still resolves, from the inline patch.
    await expect(versions.getDiff(DOC_ID, 3)).resolves.toContain("@@");
  });

  it("externalizeDiffs moves inline patches into files without changing content", async () => {
    await buildChain(4);

    // Put the chain back in the old inline shape.
    const history = (await storage.readHistory(DOC_ID))!;
    const original: Record<number, string> = {};
    for (const entry of history.versions) {
      if (entry.keyframe) continue;
      original[entry.version] = (await storage.readDiff(DOC_ID, entry.version))!;
      entry.diff = original[entry.version];
      await rm(join(dir, `nodes/.versions/demo/v${entry.version}.diff`));
    }
    await storage.writeHistory(DOC_ID, history);

    await expect(versions.externalizeDiffs(DOC_ID)).resolves.toBe(3);

    const after = (await storage.readHistory(DOC_ID))!;
    for (const entry of after.versions) {
      expect(entry.diff).toBeUndefined();
      // Hashes are untouched — the same bytes just moved to their own file.
      if (entry.keyframe) continue;
      await expect(storage.readDiff(DOC_ID, entry.version)).resolves.toBe(
        original[entry.version],
      );
    }
    for (let v = 1; v <= 4; v++) {
      await expect(versions.reconstructVersion(DOC_ID, v)).resolves.toContain(
        `body line ${v}`,
      );
    }
    // Idempotent — nothing left to move.
    await expect(versions.externalizeDiffs(DOC_ID)).resolves.toBe(0);
  });

  it("repairLatestVersion leaves a healthy chain untouched", async () => {
    await buildChain(3);
    const before = await storage.readHistory(DOC_ID);

    await expect(versions.repairLatestVersion(DOC_ID)).resolves.toBe(false);
    expect(await storage.readHistory(DOC_ID)).toEqual(before);
  });
});
