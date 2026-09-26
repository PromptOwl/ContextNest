/**
 * The forget protocol (spec §6.3): node forget, the audit trail,
 * anti-resurrection, and tombstoned delete.
 *
 * The property under test throughout is the OMP procurement sentence:
 * "`forget` leaves `verify` passing" — while the forgotten content is gone from
 * every file in the vault, and stays gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, relative } from "node:path";
import { mkdtemp, rm, readFile, writeFile, readdir, stat, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { CheckpointManager } from "../checkpoint.js";
import { Resolver } from "../resolver.js";
import { parseUri } from "../uri.js";
import { parseSelector } from "../selector/parser.js";
import { evaluate } from "../selector/evaluator.js";
import { publishDocument } from "../publish.js";
import { filterDocuments } from "../filters.js";
import { normalizeStatus } from "../parser.js";
import { forgetDocument, forgetLog } from "../forget.js";
import { createEngineApi, type OperationContext } from "../api/index.js";

const api = createEngineApi();

async function makeContext(): Promise<{ ctx: OperationContext; dir: string; storage: NestStorage }> {
  const dir = await mkdtemp(join(tmpdir(), "contextnest-forget-"));
  const storage = new NestStorage(dir);
  return {
    dir,
    storage,
    ctx: {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "steward@example.com",
    },
  };
}

/** Every file under `dir`, as `relpath → text`. */
async function allFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(d: string): Promise<void> {
    for (const name of await readdir(d)) {
      const p = join(d, name);
      if ((await stat(p)).isDirectory()) await walk(p);
      else out.set(relative(dir, p).replace(/\\/g, "/"), await readFile(p, "utf-8"));
    }
  }
  await walk(dir);
  return out;
}

/** Files anywhere in the vault that still contain `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  return [...(await allFiles(dir))].filter(([, text]) => text.includes(needle)).map(([p]) => p);
}

async function resolverFor(storage: NestStorage): Promise<Resolver> {
  const vm = new VersionManager(storage);
  return new Resolver({
    documents: await storage.discoverDocuments(),
    checkpoints: (await storage.readCheckpointHistory())?.checkpoints ?? [],
    reconstructVersion: (id, v) => vm.reconstructVersion(id, v),
  });
}

async function select(storage: NestStorage, selector: string): Promise<string[]> {
  const resolver = await resolverFor(storage);
  return (await evaluate(parseSelector(selector), { resolver })).map((d) => d.id);
}

describe("forget protocol — node forget (§6.3.3)", () => {
  let ctx: OperationContext;
  let dir: string;
  let storage: NestStorage;
  let id: string;

  beforeEach(async () => {
    ({ ctx, dir, storage } = await makeContext());
    const created = await api.run<{ id: string }>(
      "context_create",
      {
        title: "Jane Notes",
        content: "Jane's diagnosis is PINEAPPLE-ONE, recorded at intake.",
        tags: ["#patients"],
        description: "Intake notes",
      },
      ctx,
    );
    id = created.id;
    await api.run(
      "context_update",
      { id, content: "Jane's diagnosis is PINEAPPLE-TWO, revised after review.", note: "PINEAPPLE note" },
      ctx,
    );
    await api.run("context_create", { title: "Other", content: "unrelated, stays put", tags: ["#patients"] }, ctx);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("erases every version's content, leaves an empty stub, and verify still passes", async () => {
    const before = (await storage.readHistory(id))!.versions.map((e) => ({ ...e }));
    const out = await api.run<{ id: string; versions: number[]; stub_version: number; checkpoint: number }>(
      "context_forget",
      { id, reason_code: "user_request", requested_by: "jane@example.com" },
      ctx,
    );
    expect(out).toMatchObject({ id, versions: [1, 2], stub_version: 3 });

    // Content gone from EVERY file in the vault — keyframes, diffs, notes, indexes.
    expect(await filesContaining(dir, "PINEAPPLE")).toEqual([]);

    // The stub: the eight keys, status forgotten, empty body.
    const stub = await storage.readDocument(id);
    expect(stub.frontmatter.status).toBe("forgotten");
    expect(stub.body.trim()).toBe("");
    expect(stub.frontmatter.title).toBe("Jane Notes");
    expect(stub.frontmatter.tags).toEqual(["#patients"]);
    expect(stub.frontmatter.version).toBe(3);
    expect(stub.frontmatter.checksum).toMatch(/^sha256:/);
    expect(stub.frontmatter.created_at).toBeDefined();
    expect(stub.frontmatter.updated_at).toBeDefined();
    expect(stub.frontmatter.description).toBeUndefined();

    // Tombstones keep their hashes unchanged; the stub is sealed after them.
    const history = (await storage.readHistory(id))!;
    for (const [i, orig] of before.entries()) {
      const e = history.versions[i];
      expect(e.tombstone).toBe(true);
      expect(e.content_hash).toBe(orig.content_hash);
      expect(e.chain_hash).toBe(orig.chain_hash);
      expect(e.reason_code).toBe("user_request");
      expect(e.forgotten_by).toBe("steward@example.com");
      expect(e.note).toBeUndefined();
    }
    expect(history.versions.at(-1)).toMatchObject({ version: 3, keyframe: true, forget_stub: true });

    const report = await storage.verifyVaultIntegrity();
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.tombstoned).toEqual([
      { document: id, version: 1 },
      { document: id, version: 2 },
    ]);

    // Rebuilding the checkpoint log from the histories still verifies.
    await new CheckpointManager(storage).rebuildCheckpointHistory();
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
  });

  it("reconstructing a forgotten version reports VERSION_FORGOTTEN, not stale content", async () => {
    await forgetDocument(storage, id, { reasonCode: "legal", forgottenBy: "dpo@example.com" });
    await expect(new VersionManager(storage).reconstructVersion(id, 1)).rejects.toMatchObject({
      code: "VERSION_FORGOTTEN",
    });
    await expect(api.run("context_reconstruct", { id, version: 2 }, ctx)).rejects.toMatchObject({
      code: "VERSION_FORGOTTEN",
    });
  });

  it("floating and pinned URIs resolve to `forgotten`, never null", async () => {
    // Checkpoint 2 sealed v2 of the node.
    const cp2 = (await storage.readCheckpointHistory())!.checkpoints[1];
    expect(cp2.document_versions[id]).toBe(2);

    await forgetDocument(storage, id, { reasonCode: "user_request", forgottenBy: "s@example.com" });
    const resolver = await resolverFor(storage);

    const floating = await resolver.resolve(parseUri(`contextnest://${id}`));
    expect(floating).toHaveLength(1);
    expect(floating[0].frontmatter.status).toBe("forgotten");
    expect(floating[0].body).toBe("");

    const pinned = await resolver.resolve(parseUri(`contextnest://${id}@2`));
    expect(pinned).toHaveLength(1);
    expect(pinned[0].frontmatter.status).toBe("forgotten");
    expect(pinned[0].frontmatter.version).toBe(2);
    expect(pinned[0].body).toBe("");

    // context_get serves the stub, marked forgotten, rather than DOCUMENT_NOT_FOUND.
    const got = await api.run<{ frontmatter: { status: string }; body: string }>("context_get", { id }, ctx);
    expect(got.frontmatter.status).toBe("forgotten");
    expect(got.body.trim()).toBe("");
  });

  it("is excluded from retrieval and selectors unless status:forgotten is asked for", async () => {
    await forgetDocument(storage, id, { reasonCode: "user_request", forgottenBy: "s@example.com" });
    await storage.regenerateIndex();

    expect(await select(storage, "#patients")).not.toContain(id);
    expect(await select(storage, `contextnest://${id}`)).toEqual([]);
    expect(await select(storage, "status:forgotten")).toEqual([id]);
    expect(await select(storage, "#patients + status:forgotten")).toEqual([id]);
    expect(await select(storage, "#patients -status:forgotten")).not.toContain(id);
    expect(normalizeStatus("forgotten")).toBe("forgotten");

    const q = await new GraphQueryEngine(storage).query("#patients", { includeDrafts: true });
    expect(q.documents.map((d) => d.id)).not.toContain(id);
    const full = await new GraphQueryEngine(storage).query("#patients", { full: true, includeDrafts: true });
    expect(full.documents.map((d) => d.id)).not.toContain(id);

    const search = await api.run<{ results: Array<{ id: string }> }>("context_search", { query: "diagnosis" }, ctx);
    expect(search.results.map((r) => r.id)).not.toContain(id);

    const docs = await storage.discoverDocuments({ includeRetired: true });
    expect(filterDocuments(docs).map((d) => d.id)).not.toContain(id);
    expect(filterDocuments(docs, { status: "forgotten" }).map((d) => d.id)).toEqual([id]);

    const contextYaml = await storage.readContextYaml();
    expect(contextYaml!.documents.map((d) => d.id)).not.toContain(id);
  });

  it("records an audit event with who/when/why/which versions — and no content", async () => {
    await api.run("context_forget", { id, reason_code: "user_request", requested_by: "jane@example.com" }, ctx);
    const log = await api.run<{ events: Array<Record<string, unknown>> }>("context_forget_log", { id }, ctx);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({
      document_id: id,
      scope: "node",
      mode: "forget",
      versions: [1, 2],
      reason_code: "user_request",
      forgotten_by: "steward@example.com",
      requested_by: "jane@example.com",
      stub_version: 3,
    });
    const raw = await readFile(join(dir, ".versions", "chain_events.yaml"), "utf-8");
    expect(raw).toContain("document.forgotten");
    expect(raw).not.toContain("PINEAPPLE");
    expect(await forgetLog(storage)).toHaveLength(1);
  });

  it("verify still detects tampering after a forget", async () => {
    const versionsDir = join(dir, "nodes", ".versions", "jane-notes");
    const oldV1 = await readFile(join(versionsDir, "v1.md"), "utf-8");
    await forgetDocument(storage, id, { reasonCode: "user_request", forgottenBy: "s@example.com" });
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
    const types = async () =>
      (await storage.verifyVaultIntegrity()).errors.map((e) => `${e.type}@${e.version ?? ""}`);

    // The stub's own keyframe edited after the forget.
    const v3 = join(versionsDir, "v3.md");
    const v3Text = await readFile(v3, "utf-8");
    await writeFile(v3, v3Text.replace("Jane Notes", "Someone Else"));
    expect(await types()).toContain("content_hash_mismatch@3");
    await writeFile(v3, v3Text);

    // Erased content put back by hand (restored from a backup).
    await writeFile(join(versionsDir, "v1.md"), oldV1);
    expect(await types()).toContain("forgotten_content_present@1");
    await rm(join(versionsDir, "v1.md"));

    // A tombstone's chained hash rewritten.
    const historyPath = join(versionsDir, "history.yaml");
    const historyText = await readFile(historyPath, "utf-8");
    const h = yaml.load(historyText) as { versions: Array<Record<string, unknown>> };
    h.versions[0].chain_hash = `sha256:${"0".repeat(64)}`;
    await writeFile(historyPath, yaml.dump(h));
    expect(await types()).toContain("chain_hash_mismatch@1");
    await writeFile(historyPath, historyText);

    // Another document's version "forgotten" by hand, with no recorded forget.
    const otherPath = join(dir, "nodes", ".versions", "other", "history.yaml");
    const other = yaml.load(await readFile(otherPath, "utf-8")) as typeof h;
    other.versions[0].tombstone = true;
    await writeFile(otherPath, yaml.dump(other));
    expect(await types()).toContain("unrecorded_tombstone@1");
  });

  it("refuses a free-text reason, a second forget, and edits of the stub", async () => {
    await expect(
      api.run("context_forget", { id, reason_code: "because jane asked" }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await forgetDocument(storage, id, { reasonCode: "user_request", forgottenBy: "s@example.com" });
    await expect(
      forgetDocument(storage, id, { reasonCode: "user_request", forgottenBy: "s@example.com" }),
    ).rejects.toMatchObject({ code: "FORGOTTEN_DOCUMENT" });
    await expect(api.run("context_update", { id, content: "back again" }, ctx)).rejects.toMatchObject({
      code: "FORGOTTEN_DOCUMENT",
    });
    await expect(api.run("context_publish", { id }, ctx)).rejects.toMatchObject({
      code: "FORGOTTEN_DOCUMENT",
    });
    // `forgotten` is not a status a caller can set by hand.
    await expect(
      api.run("context_create", { title: "Fake", content: "x", status: "forgotten", publish: false }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

});

describe("forget protocol — anti-resurrection (§6.3.4)", () => {
  let ctx: OperationContext;
  let dir: string;
  let storage: NestStorage;
  let id: string;
  let preForget: Map<string, string>;

  beforeEach(async () => {
    ({ ctx, dir, storage } = await makeContext());
    id = (
      await api.run<{ id: string }>(
        "context_create",
        { title: "Secret Plan", content: "The acquisition target is MANGO-CORP, codename orchard." },
        ctx,
      )
    ).id;
    await api.run("context_update", { id, content: "The acquisition target is MANGO-CORP, closing in Q3." }, ctx);
    preForget = await allFiles(dir);
    await forgetDocument(storage, id, { reasonCode: "legal", forgottenBy: "dpo@example.com" });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const docFiles = (files: Map<string, string>) =>
    [...files]
      .filter(([p]) => p.startsWith("nodes/secret-plan") || p.startsWith("nodes/.versions/secret-plan/"))
      .map(([path, content]) => ({ path, content }));

  it("refuses to republish a restored pre-forget copy of the live file", async () => {
    await writeFile(join(dir, `${id}.md`), preForget.get(`${id}.md`)!);
    await expect(publishDocument(storage, id, { editedBy: "x" })).rejects.toMatchObject({
      code: "FORGOTTEN_DOCUMENT",
    });
    // …and verify flags the restored file.
    const errors = (await storage.verifyVaultIntegrity()).errors.map((e) => e.type);
    expect(errors).toContain("forgotten_content_present");
  });

  it("an import of the pre-forget copy restores nothing — at its own path or a new one", async () => {
    const files = docFiles(preForget);
    expect(files.length).toBeGreaterThanOrEqual(3); // live .md, history.yaml, v1.md, v2.diff
    const res = await api.run<{ failed: Array<{ id?: string; error: string }> }>(
      "context_import",
      { files, overwrite: true, publish: false },
      ctx,
    );
    expect(res.failed.length).toBe(files.length);
    expect(await filesContaining(dir, "MANGO-CORP")).toEqual([]);
    expect((await storage.readDocument(id)).frontmatter.status).toBe("forgotten");

    // Same content, renamed: refused by content hash, not by path.
    const renamed = files.map((f) => ({
      path: f.path.replace("secret-plan", "renamed-plan"),
      content: f.content,
    }));
    const res2 = await api.run<{ failed: unknown[] }>("context_import", { files: renamed, publish: false }, ctx);
    expect(res2.failed.length).toBe(renamed.length);
    expect(await filesContaining(dir, "MANGO-CORP")).toEqual([]);
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
  });

  it("an import carrying tombstones forgets the pre-forget copy the receiving vault holds", async () => {
    // A second vault that holds the pre-forget copy…
    const other = await makeContext();
    try {
      for (const [p, content] of preForget) {
        await other.storage.writeVaultFile(p, content);
      }
      expect(await filesContaining(other.dir, "MANGO-CORP")).not.toEqual([]);

      // …imports the post-forget export: the stub, the tombstoned history, and
      // the chain-event log that carries the forget.
      const exported = await allFiles(dir);
      const files = [
        ...docFiles(exported),
        { path: ".versions/chain_events.yaml", content: exported.get(".versions/chain_events.yaml")! },
      ];
      await api.run("context_import", { files, overwrite: true, publish: false }, other.ctx);

      expect(await filesContaining(other.dir, "MANGO-CORP")).toEqual([]);
      expect((await other.storage.verifyVaultIntegrity()).errors).toEqual([]);
      expect((await other.storage.readDocument(id)).frontmatter.status).toBe("forgotten");
      expect(await forgetLog(other.storage, id)).toHaveLength(1);
      await expect(publishDocument(other.storage, id, { editedBy: "x" })).rejects.toMatchObject({
        code: "FORGOTTEN_DOCUMENT",
      });
    } finally {
      await rm(other.dir, { recursive: true, force: true });
    }
  });

  it("a copied vault carries its tombstones (export is the directory)", async () => {
    const copy = await mkdtemp(join(tmpdir(), "contextnest-forget-copy-"));
    try {
      await cp(dir, copy, { recursive: true });
      const copied = new NestStorage(copy);
      expect((await copied.verifyVaultIntegrity()).valid).toBe(true);
      await writeFile(join(copy, `${id}.md`), preForget.get(`${id}.md`)!);
      await expect(publishDocument(copied, id, { editedBy: "x" })).rejects.toMatchObject({
        code: "FORGOTTEN_DOCUMENT",
      });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });
});

describe("forget protocol — delete leaves a tombstone", () => {
  let ctx: OperationContext;
  let dir: string;
  let storage: NestStorage;

  beforeEach(async () => {
    ({ ctx, dir, storage } = await makeContext());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("context_delete removes the node and records a tombstone that refuses resurrection", async () => {
    const { id } = await api.run<{ id: string }>(
      "context_create",
      { title: "Doomed", content: "The launch date is KIWI-DAY, keep it quiet." },
      ctx,
    );
    const raw = await readFile(join(dir, `${id}.md`), "utf-8");
    const out = await api.run<{ deleted: boolean; tombstoned: boolean }>("context_delete", { id }, ctx);
    expect(out).toMatchObject({ deleted: true, tombstoned: true });
    expect(existsSync(join(dir, `${id}.md`))).toBe(false);
    expect(existsSync(join(dir, "nodes", ".versions", "doomed"))).toBe(false);
    await expect(api.run("context_get", { id }, ctx)).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });

    const [event] = await forgetLog(storage, id);
    expect(event).toMatchObject({ scope: "node", mode: "delete", reason_code: "user_request" });
    expect(await readFile(join(dir, ".versions", "chain_events.yaml"), "utf-8")).not.toContain("KIWI-DAY");

    // Re-creating the path and publishing is refused…
    await writeFile(join(dir, `${id}.md`), raw);
    await expect(publishDocument(storage, id, { editedBy: "x" })).rejects.toMatchObject({
      code: "FORGOTTEN_DOCUMENT",
    });
    await rm(join(dir, `${id}.md`));
    // …and so is importing the old content under another name.
    const res = await api.run<{ failed: unknown[] }>(
      "context_import",
      { files: [{ path: "nodes/sneaky.md", content: raw }] },
      ctx,
    );
    expect(res.failed).toHaveLength(1);
    expect((await storage.verifyVaultIntegrity()).valid).toBe(true);
  });

  it("purge deletes without a tombstone, so the path can be reused", async () => {
    const { id } = await api.run<{ id: string }>("context_create", { title: "Scratch", content: "scratch body text here" }, ctx);
    const out = await api.run<{ tombstoned: boolean }>("context_delete", { id, purge: true }, ctx);
    expect(out.tombstoned).toBe(false);
    expect(await forgetLog(storage)).toEqual([]);
    const again = await api.run<{ id: string }>("context_create", { title: "Scratch", content: "scratch body text here" }, ctx);
    expect(again.id).toBe(id);
  });
});
