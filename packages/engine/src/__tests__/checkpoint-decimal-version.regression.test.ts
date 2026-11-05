import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../publish.js";

/**
 * Vaults imported before import hygiene made versions whole numbers still hold
 * documents at a decimal front-matter version (`version: 2.1`). The checkpoint
 * seal records that version, so its reader must accept it — otherwise every
 * later write quarantined context_history.yaml as corrupt and restarted the chain.
 */
describe("checkpoint chain with a legacy decimal document version", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-cpdecimal-"));
    storage = new NestStorage(root);
    await storage.init("Decimal Version Vault");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps one readable chain across writes", async () => {
    // Already-published legacy doc, as an older import left it on disk.
    await storage.writeDocument(
      "nodes/legacy",
      `---\ntitle: Legacy\ntype: document\nstatus: published\nversion: 2.1\n---\n\n# Legacy\n`,
    );
    for (const id of ["nodes/a", "nodes/b"]) {
      await storage.writeDocument(id, `---\ntitle: ${id}\ntype: document\nstatus: draft\n---\n\n# ${id}\n`);
      await publishDocument(storage, id, { editedBy: "a@x.com" });
    }

    const cph = await storage.readCheckpointHistory();
    expect(cph?.checkpoints.length).toBeGreaterThanOrEqual(2);
    const files = await readdir(join(root, ".versions"));
    expect(files.filter((f) => f.includes(".corrupt"))).toEqual([]);
  });
});
