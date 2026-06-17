import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { publishDocument } from "../index.js";

// chmod 000 does not restrict access for root, and is a no-op on Windows —
// skip the permission test there to avoid false negatives.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const skip = isRoot || process.platform === "win32";

describe("NestStorage.findAllHistories — permission-denied directories", () => {
  let vault: string;
  let storage: NestStorage;
  let lockedDir = "";

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "cn-perm-"));
    storage = new NestStorage(vault);
  });

  afterEach(async () => {
    // Restore perms first so rm can recurse into the locked directory.
    if (lockedDir) {
      await chmod(lockedDir, 0o755).catch(() => {});
      lockedDir = "";
    }
    await rm(vault, { recursive: true, force: true });
  });

  it.skipIf(skip)(
    "skips unreadable directories instead of crashing the crawl",
    async () => {
      // Seed one real document + history under the vault root.
      const docId = "nodes/api-design";
      await storage.writeDocument(
        docId,
        `---\ntitle: API Design\ntype: document\nstatus: draft\n---\n\n# API Design\n\nBody.\n`,
      );
      await publishDocument(storage, docId, { editedBy: "tester@local" });

      // Create a sibling directory the crawl cannot read into.
      lockedDir = join(vault, "locked");
      await mkdir(lockedDir, { recursive: true });
      await chmod(lockedDir, 0o000);

      // Without suppressErrors this rejects with EACCES; with the fix it
      // resolves and still surfaces the readable history.
      const histories = await storage.findAllHistories();
      expect(histories.has(docId)).toBe(true);
    },
  );

  it("returns histories for a clean vault", async () => {
    const docId = "nodes/clean-doc";
    await storage.writeDocument(
      docId,
      `---\ntitle: Clean Doc\ntype: document\nstatus: draft\n---\n\nBody.\n`,
    );
    await publishDocument(storage, docId, { editedBy: "tester@local" });

    const histories = await storage.findAllHistories();
    expect(histories.has(docId)).toBe(true);
  });
});
