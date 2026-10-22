/**
 * context_import `ids` as a bulk approval: the caller's note lands on every
 * published version, each doc's chain continues intact, and the batch seals
 * ONE checkpoint — the governance layer relies on all three to replace N
 * single publishes with one call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { serializeDocument } from "../parser.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

describe("context_import ids with a note (bulk approval)", () => {
  let ctx: OperationContext;
  let storage: NestStorage;
  let dir: string;
  const api = createEngineApi();
  const checkpoints = async () => (await storage.readCheckpointHistory())?.checkpoints.length ?? 0;

  /** A published v1 doc whose author then saved an edit and submitted it. */
  const pendingEdit = async (id: string): Promise<void> => {
    await api.run("context_create", { id, title: id, content: "v1 body" }, ctx);
    const node = await storage.readDocument(id);
    node.frontmatter.status = "pending_review";
    node.body = "\nv2 body\n";
    await storage.writeDocument(id, serializeDocument(node));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextnest-import-note-"));
    storage = new NestStorage(dir);
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "reviewer@example.com",
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records the note on every version, keeps chains valid, seals one checkpoint", async () => {
    const ids = ["nodes/alpha/one", "nodes/alpha/two", "nodes/beta/three"];
    for (const id of ids) await pendingEdit(id);
    const before = await checkpoints();

    const out = await api.run<{
      published: { id: string; version: number }[];
      failed: unknown[];
      checkpoint: number | null;
    }>("context_import", { ids, note: "Approved in bulk review" }, ctx);

    expect(out.failed).toEqual([]);
    expect(out.published.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(out.published.every((p) => p.version === 2)).toBe(true);
    expect(await checkpoints()).toBe(before + 1);

    for (const id of ids) {
      const history = await storage.readHistory(id);
      const last = history!.versions.at(-1)!;
      expect(last.version).toBe(2);
      expect(last.note).toBe("Approved in bulk review");
      expect(last.edited_by).toBe("reviewer@example.com");
      const doc = await storage.readDocument(id);
      expect(doc.frontmatter.status).toBe("published");
      expect(doc.body).toContain("v2 body");
    }
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);

    const contextYaml = await readFile(join(dir, "context.yaml"), "utf-8");
    for (const id of ids) expect(contextYaml).toMatch(new RegExp(`id: ${id}\\n[\\s\\S]*?version: 2`));
  });

  it("reports a doc that can't publish without blocking the rest", async () => {
    await pendingEdit("nodes/alpha/ok");
    await pendingEdit("nodes/alpha/gone");
    await api.run("context_delete", { id: "nodes/alpha/gone" }, ctx);

    const out = await api.run<{ published: { id: string }[]; failed: { id?: string }[] }>(
      "context_import",
      { ids: ["nodes/alpha/ok", "nodes/alpha/gone"], note: "bulk" },
      ctx,
    );

    expect(out.published.map((p) => p.id)).toEqual(["nodes/alpha/ok"]);
    expect(out.failed.map((f) => f.id)).toEqual(["nodes/alpha/gone"]);
    expect((await storage.readHistory("nodes/alpha/ok"))!.versions.at(-1)!.note).toBe("bulk");
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
  });
});
