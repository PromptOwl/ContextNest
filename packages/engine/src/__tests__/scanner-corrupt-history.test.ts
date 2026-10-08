import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";
import { runHygienistScan } from "../hygienist.js";
import { scanCheckpointDrift } from "../checkpoint.js";
import type { RbacHook } from "../types.js";

/**
 * Both vault-wide scanners document a no-throw contract: one ill-formed
 * document is reported with a `skippedReason` and the scan continues, so a
 * single bad file cannot fail a checkpoint or a hygienist pass wholesale.
 *
 * `readHistory` raising `CorruptHistoryError` on a present-but-unreadable
 * history.yaml put that contract at risk — the call sites read it uncaught, so
 * one corrupt document aborted the entire scan for every other document. These
 * pin the contract at both call sites.
 */

const allowAll: RbacHook = {
  canIngest: async () => true,
  canApprove: async () => true,
  canPublish: async () => true,
} as unknown as RbacHook;

const draft = (title: string): string =>
  `---\ntitle: ${title}\ntype: document\nstatus: draft\n---\n\n# ${title}\n\nbody\n`;

describe("vault scanners survive one corrupt history.yaml", () => {
  let root: string;
  let storage: NestStorage;
  const names = ["good-a", "bad", "good-b"];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-scan-corrupt-"));
    storage = new NestStorage(root);
    await storage.init("Scanner Vault");

    for (const name of names) {
      const id = `nodes/${name}`;
      await storage.writeDocument(id, draft(name));
      await publishDocument(storage, id, { editedBy: "tester" });
      // Drift each document so the scan proceeds past the cheap early-outs and
      // actually reaches the history read.
      const path = join(root, "nodes", `${name}.md`);
      await writeFile(path, (await readFile(path, "utf-8")) + "\ndrifted\n", "utf-8");
    }

    await writeFile(
      join(root, "nodes", ".versions", "bad", "history.yaml"),
      "versions:\n  - version: 1\0\0\0\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scanCheckpointDrift reports the bad document and still scans the rest", async () => {
    const result = await scanCheckpointDrift({
      storage,
      actor: "tester",
      defaultZone: "core",
      rbac: allowAll,
    } as never);

    expect(result.scanned).toBe(names.length);
    const bad = result.entries.find((e) => e.documentId === "nodes/bad");
    expect(bad?.skippedReason).toMatch(/unreadable-history/);
    // The other two were still examined rather than lost with the throw.
    for (const id of ["nodes/good-a", "nodes/good-b"]) {
      expect(result.entries.some((e) => e.documentId === id)).toBe(true);
    }
  });

  it("runHygienistScan reports the bad document and still scans the rest", async () => {
    const result = await runHygienistScan({
      storage,
      actor: "tester",
      defaultZone: "core",
      rbac: allowAll,
    } as never);

    expect(result.scanned).toBe(names.length);
    const bad = result.entries.find((e) => e.documentId === "nodes/bad");
    expect(bad?.skippedReason).toMatch(/unreadable-history/);
    for (const id of ["nodes/good-a", "nodes/good-b"]) {
      expect(result.entries.some((e) => e.documentId === id)).toBe(true);
    }
  });
});
