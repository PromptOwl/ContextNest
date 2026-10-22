/**
 * NestBench T10: a document whose body no longer matches its hash chain was
 * served by the retrieval path with nothing telling the model verification
 * failed, so the model answered with the tampered value. The document must
 * still be served (it is the one asked about) — but flagged.
 *
 * Contract pinned here:
 *   1. A tampered document served by graph query / context_get / context_query /
 *      context_resolve carries `integrity: { status: "failed", ... }` with the
 *      model-facing warning line.
 *   2. An intact document carries no `integrity` key at all (wire unchanged).
 *   3. A tampered keyframe (history chain) is flagged too.
 *   4. The chain check is cached per history version, not redone per read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import { INTEGRITY_WARNING, withIntegrityWarning } from "../integrity.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import type { ContextNode, Frontmatter } from "../types.js";

function doc(id: string, title: string, body: string): ContextNode {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "draft",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  return { id, filePath: "", frontmatter, body, rawContent: "" };
}

describe("served documents carry an integrity verdict when verification fails", () => {
  let vaultPath: string;
  let storage: NestStorage;
  let ctx: OperationContext;

  async function addDoc(id: string, title: string, body: string): Promise<void> {
    await storage.writeDocument(id, serializeDocument(doc(id, title, `\n${body}\n`)));
    await publishDocument(storage, id, { editedBy: "test@local", note: "test" });
  }

  /** Out-of-band edit of the live body, frontmatter (and its checksum) untouched. */
  async function tamperBody(id: string, from: string, to: string): Promise<void> {
    const path = join(vaultPath, `${id}.md`);
    const raw = await readFile(path, "utf-8");
    expect(raw).toContain(from);
    await writeFile(path, raw.replace(from, to), "utf-8");
  }

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "contextnest-served-integrity-"));
    storage = new NestStorage(vaultPath);
    await storage.init("Served Integrity Vault");
    await addDoc("nodes/pricing", "Pricing", "The enterprise tier costs $500 per seat.");
    await addDoc("nodes/intact", "Intact", "Support hours are 9-5 ET. See [[Pricing]].");
    await storage.regenerateIndex();
    ctx = {
      storage,
      query: new GraphQueryEngine(storage),
      versions: new VersionManager(storage),
      actor: "tester@example.com",
    };
  });

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  it("intact documents are served with no integrity key", async () => {
    const api = createEngineApi();
    const got = await api.run<Record<string, unknown>>("context_get", { id: "nodes/intact" }, ctx);
    expect(got).not.toHaveProperty("integrity");

    const q = await api.run<{ documents: Array<Record<string, unknown>> }>(
      "context_query",
      { query: "nodes/intact", hops: 1 },
      ctx,
    );
    expect(q.documents.length).toBe(2);
    for (const d of q.documents) expect(d).not.toHaveProperty("integrity");
  });

  it("a tampered body is still served, flagged with the warning (context_get)", async () => {
    await tamperBody("nodes/pricing", "$500", "$5");
    const api = createEngineApi();
    const got = await api.run<{
      body: string;
      integrity?: { status: string; checks: string[]; warning: string };
    }>("context_get", { id: "nodes/pricing" }, ctx);

    expect(got.body).toContain("$5 per seat"); // served, not refused
    expect(got.integrity).toEqual({
      status: "failed",
      checks: ["body_drift"],
      warning: INTEGRITY_WARNING,
    });
    // The verdict precedes the body in the payload an agent reads top-down.
    const keys = Object.keys(got);
    expect(keys.indexOf("integrity")).toBeLessThan(keys.indexOf("body"));
  });

  it("graph query, context_query and context_resolve flag only the tampered document", async () => {
    await tamperBody("nodes/pricing", "$500", "$5");

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("nodes/intact", { hops: 1 });
    const byId = new Map(result.documents.map((d) => [d.id, d]));
    expect(byId.get("nodes/pricing")?.integrity?.status).toBe("failed");
    expect(byId.get("nodes/intact")?.integrity).toBeUndefined();

    const api = createEngineApi();
    const q = await api.run<{ documents: Array<{ id: string; integrity?: { status: string } }> }>(
      "context_query",
      { query: "nodes/pricing", hops: 0 },
      ctx,
    );
    expect(q.documents).toHaveLength(1);
    expect(q.documents[0].integrity?.status).toBe("failed");

    const full = await api.run<{ documents: Array<{ id: string; integrity?: { status: string } }> }>(
      "context_query",
      { query: "nodes/pricing", full: true },
      ctx,
    );
    expect(full.documents[0].integrity?.status).toBe("failed");

    const r = await api.run<{ documents: Array<{ id: string; integrity?: { warning: string } }> }>(
      "context_resolve",
      { selector: "nodes/pricing", hops: 0 },
      ctx,
    );
    expect(r.documents[0].integrity?.warning).toBe(INTEGRITY_WARNING);
  });

  it("a tampered keyframe (broken version chain) is flagged even with the live body intact", async () => {
    const history = await storage.readHistory("nodes/pricing");
    const kf = history!.versions.find((v) => v.keyframe)!;
    const keyframe = join(vaultPath, "nodes", ".versions", "pricing", `v${kf.version}.md`);
    const raw = await readFile(keyframe, "utf-8");
    await writeFile(keyframe, raw.replace("$500", "$5"), "utf-8");

    const node = await storage.readDocument("nodes/pricing");
    const verdict = await storage.verifyServedDocument(node);
    expect(verdict?.status).toBe("failed");
    expect(verdict?.checks).toContain("content_hash_mismatch");
  });

  it("verify_checksum + drift: serves the approved keyframe unflagged when its chain is intact", async () => {
    await tamperBody("nodes/pricing", "$500", "$5");
    const api = createEngineApi();
    const got = await api.run<Record<string, any>>(
      "context_get",
      { id: "nodes/pricing", verify_checksum: true },
      ctx,
    );
    expect(got.body).toContain("$500"); // canonical content, not the drifted bytes
    expect(got.pendingChange).toBeDefined();
    expect(got).not.toHaveProperty("integrity");
  });

  it("verify_checksum + drift still runs the chain check on what it serves", async () => {
    await tamperBody("nodes/pricing", "$500", "$5");
    const history = await storage.readHistory("nodes/pricing");
    const kf = history!.versions.find((v) => v.keyframe)!;
    const keyframe = join(vaultPath, "nodes", ".versions", "pricing", `v${kf.version}.md`);
    await writeFile(keyframe, (await readFile(keyframe, "utf-8")).replace("$500", "$50"), "utf-8");

    const api = createEngineApi();
    const got = await api.run<Record<string, any>>(
      "context_get",
      { id: "nodes/pricing", verify_checksum: true },
      ctx,
    );
    expect(got.pendingChange).toBeDefined();
    expect(got.integrity?.status).toBe("failed");
    expect(got.integrity?.checks).toContain("content_hash_mismatch");
  });

  it("a history that exists but cannot be read is flagged unreadable_history", async () => {
    const historyFile = join(vaultPath, "nodes", ".versions", "pricing", "history.yaml");
    await rm(historyFile);
    await mkdir(historyFile); // present but unreadable as a file (EISDIR)
    const node = await storage.readDocument("nodes/pricing");
    const verdict = await storage.verifyServedDocument(node);
    expect(verdict?.checks).toEqual(["unreadable_history"]);
  });

  it("context_list full: flags the tampered body, leaves the intact one clean", async () => {
    await tamperBody("nodes/pricing", "$500", "$5");
    const api = createEngineApi();
    const full = await api.run<{ documents: Array<Record<string, any>> }>(
      "context_list",
      { full: true },
      ctx,
    );
    const byId = new Map(full.documents.map((d) => [d.id, d]));
    expect(byId.get("nodes/pricing")?.body).toContain("$5 per seat");
    expect(byId.get("nodes/pricing")?.integrity).toEqual({
      status: "failed",
      checks: ["body_drift"],
      warning: INTEGRITY_WARNING,
    });
    expect(byId.get("nodes/intact")).not.toHaveProperty("integrity");
  });

  it("context_list summary mode stays cheap: no body, no verification", async () => {
    await tamperBody("nodes/pricing", "$500", "$5");
    const spy = vi.spyOn(storage, "verifyServedDocument");
    const api = createEngineApi();
    const summary = await api.run<{ documents: Array<Record<string, any>> }>(
      "context_list",
      {},
      ctx,
    );
    expect(spy).not.toHaveBeenCalled();
    for (const d of summary.documents) {
      expect(d).not.toHaveProperty("body");
      expect(d).not.toHaveProperty("integrity");
    }
    spy.mockRestore();
  });

  it("context_reconstruct flags a version rebuilt from a broken chain, not an intact one", async () => {
    const api = createEngineApi();
    const history = await storage.readHistory("nodes/pricing");
    const kf = history!.versions.find((v) => v.keyframe)!;

    const clean = await api.run<Record<string, any>>(
      "context_reconstruct",
      { id: "nodes/pricing", version: kf.version },
      ctx,
    );
    expect(clean).not.toHaveProperty("integrity");

    // Live-body drift alone says nothing about a past version: not flagged.
    await tamperBody("nodes/pricing", "$500", "$5");
    const driftOnly = await api.run<Record<string, any>>(
      "context_reconstruct",
      { id: "nodes/pricing", version: kf.version },
      ctx,
    );
    expect(driftOnly).not.toHaveProperty("integrity");

    const keyframe = join(vaultPath, "nodes", ".versions", "pricing", `v${kf.version}.md`);
    await writeFile(keyframe, (await readFile(keyframe, "utf-8")).replace("$500", "$50"), "utf-8");
    // Fresh storage: the verdict above is cached per history.yaml digest, and a
    // keyframe altered AFTER that within the same process is the documented
    // limit (ctx verify still catches it). A new process sees it immediately.
    const fresh = new NestStorage(vaultPath);
    const broken = await api.run<Record<string, any>>(
      "context_reconstruct",
      { id: "nodes/pricing", version: kf.version },
      { ...ctx, storage: fresh, versions: new VersionManager(fresh) },
    );
    expect(broken.integrity?.checks).toContain("content_hash_mismatch");
  });

  it("context_skill / context_skill_install flag a tampered skill node", async () => {
    const skillDoc = doc("nodes/deploy", "Deploy", "\nRun the safe deploy script.\n");
    skillDoc.frontmatter.type = "skill";
    skillDoc.frontmatter.skill = { trigger: "When deploying" };
    await storage.writeDocument("nodes/deploy", serializeDocument(skillDoc));
    await publishDocument(storage, "nodes/deploy", { editedBy: "test@local", note: "t" });

    const api = createEngineApi();
    const clean = await api.run<Record<string, any>>("context_skill", { id: "nodes/deploy" }, ctx);
    expect(clean).not.toHaveProperty("integrity");

    await tamperBody("nodes/deploy", "safe deploy script", "rm -rf deploy script");
    const shown = await api.run<Record<string, any>>("context_skill", { id: "nodes/deploy" }, ctx);
    expect(shown.integrity?.status).toBe("failed");
    const installed = await api.run<Record<string, any>>(
      "context_skill_install",
      { id: "nodes/deploy" },
      ctx,
    );
    expect(installed.integrity?.status).toBe("failed");
    expect(installed.notes.startsWith(INTEGRITY_WARNING)).toBe(true);
  });

  it("rejected skill whose approved fallback fails its chain: the integrity warning leads notes", async () => {
    const skillDoc = doc("nodes/ship", "Ship", "\nRun the ship script.\n");
    skillDoc.frontmatter.type = "skill";
    skillDoc.frontmatter.skill = { trigger: "When shipping" };
    await storage.writeDocument("nodes/ship", serializeDocument(skillDoc));
    await publishDocument(storage, "nodes/ship", { editedBy: "test@local", note: "t" });

    const live = join(vaultPath, "nodes", "ship.md");
    await writeFile(
      live,
      (await readFile(live, "utf-8")).replace("status: published", "status: rejected"),
      "utf-8",
    );
    const history = await storage.readHistory("nodes/ship");
    const kf = history!.versions.find((v) => v.keyframe)!;
    const keyframe = join(vaultPath, "nodes", ".versions", "ship", `v${kf.version}.md`);
    await writeFile(keyframe, (await readFile(keyframe, "utf-8")).replace("ship script", "evil script"), "utf-8");

    const fresh = new NestStorage(vaultPath);
    const installed = await createEngineApi().run<Record<string, any>>(
      "context_skill_install",
      { id: "nodes/ship" },
      { ...ctx, storage: fresh, versions: new VersionManager(fresh) },
    );
    expect(installed.served_version).toBe(kf.version);
    expect(installed.integrity?.checks).toContain("content_hash_mismatch");
    expect(installed.notes.startsWith(INTEGRITY_WARNING)).toBe(true);
    expect(installed.notes).toContain("is rejected");
  });

  it("caches the chain verdict per history version instead of re-hashing every read", async () => {
    const spy = vi.spyOn(storage, "readKeyframe");
    const node = await storage.readDocument("nodes/intact");
    expect(await storage.verifyServedDocument(node)).toBeUndefined();
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(await storage.verifyServedDocument(node)).toBeUndefined();
    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
  });

  it("withIntegrityWarning prepends the warning line only for a failed verdict", () => {
    expect(withIntegrityWarning("# Pricing\n\n$5", { status: "failed" })).toBe(
      `${INTEGRITY_WARNING}\n\n# Pricing\n\n$5`,
    );
    expect(withIntegrityWarning("# Pricing", undefined)).toBe("# Pricing");
  });
});
