/**
 * The QA rounds' adversarial probes against the structure rules (spec
 * §11.1.1) and the import, replay, sidecar and tombstone defences around
 * them, kept as tests so every attack re-runs on every PR. Each test names
 * the QA round and the probe that found it (`r19 bigread4`: round 19's
 * bigread4 probe). Attacks with a test in structure-rules-ops.test.ts are not
 * repeated here.
 *
 * Sizes are scaled down for CI. The assertions are on what the engine decides
 * and counts — refusals, `failed[]`, the budget, the reads it asks for, files
 * left on disk, a vault still writable afterwards — with a wall-clock bound
 * only as a secondary guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access, mkdir, readdir, stat, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createPatch } from "diff";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { computeContentHash } from "../integrity.js";
import { sealedHead } from "../structure-store.js";
import { applyPatchBounded, BYTES_PER_CHAR, MAX_REPLAY_READ, replayEveryVersion } from "../reconstruct.js";
import { MemoryKeyStore, setDefaultVaultKeyStore } from "../encryption/key-store.js";
import { decryptVault, encryptVault } from "../encryption/migrate.js";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import {
  approveReview,
  approveSuggestion,
  listReviewHolds,
  rollbackDocument,
  stageReviewHold,
  stageSuggestion,
  type RbacHook,
  type StructureConfig,
} from "../index.js";
import { createEngineApi, type OperationContext } from "../api/index.js";
import { textPdf, textPdfV2, toBase64 } from "./fixtures/pdf-fixtures.js";

const SUMMARY: StructureConfig = {
  structure: { enforce: true },
  folders: { notes: { types: ["document"], template: "n" } },
  templates: { n: { body: "## Summary\n", required_sections: ["Summary"] } },
};
const ALLOW: RbacHook = { isCzar: () => true, canIngest: () => true, isDocOwner: () => true };
const ZERO = `sha256:${"0".repeat(64)}`;
const SPLIT = /split it into smaller calls/;

const api = createEngineApi();
let dir: string;
let storage: NestStorage;
let ctx: OperationContext;
const others: string[] = [];

type Failed = { id?: string; title?: string; error: string };
type ImportResult = { failed: Failed[]; published: { id: string }[]; written: number; warnings?: string[] };
type FileIn = { path: string; content: string };

function context(s: NestStorage): OperationContext {
  return { storage: s, query: new GraphQueryEngine(s), versions: new VersionManager(s), actor: "tester@example.com" };
}

async function writeConfig(extra: Record<string, unknown>, root = dir) {
  await writeFile(join(root, ".context", "config.yaml"), yaml.dump({ version: 1, name: "adv", ...extra }, { lineWidth: -1 }), "utf-8");
}

const exists = (rel: string, root = dir) =>
  access(join(root, rel)).then(
    () => true,
    () => false,
  );

/** Run an op and return the error it throws (fails the test if it doesn't). */
async function refusal(name: string, input: Record<string, unknown>, c: OperationContext = ctx) {
  try {
    await api.run(name, input, c);
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error(`${name} was expected to be refused but succeeded`);
}

const importFiles = (files: FileIn[], extra: Record<string, unknown> = {}, c: OperationContext = ctx) =>
  api.run<ImportResult>("context_import", { files, publish: false, ...extra }, c);

/** A history.yaml entry pinned to `content`. */
const entry = (version: number, content: string, keyframe = false) => ({
  version,
  keyframe,
  edited_by: "x",
  edited_at: "2026-01-01T00:00:00Z",
  content_hash: computeContentHash(content),
  chain_hash: ZERO,
});

/** A self-consistent history set for `dir/name`: one keyframe, then the given diffs. */
function plantedSet(folder: string, name: string, keyframe: string, diffs: string[]): FileIn[] {
  const V = `${folder}/.versions/${name}`;
  const versions = [entry(1, keyframe, true), ...diffs.map((d, i) => entry(i + 2, d))];
  return [
    { path: `${V}/v1.md`, content: keyframe },
    ...diffs.map((d, i) => ({ path: `${V}/v${i + 2}.diff`, content: d })),
    { path: `${V}/history.yaml`, content: yaml.dump({ keyframe_interval: 100_000, versions }, { lineWidth: -1 }) },
  ];
}

/** A second vault for the duration of one test. */
async function freshVault(layout?: "structured" | "obsidian") {
  const root = await mkdtemp(join(tmpdir(), "cn-structure-adv-b-"));
  others.push(root);
  const s = new NestStorage(root);
  await s.init("b", layout);
  return { root, storage: s, c: context(s) };
}

/** Every file under `sub` of `root`, as an export would carry it (utf-8 text). */
async function exportOf(root: string, sub: string, skip: (rel: string) => boolean = () => false): Promise<FileIn[]> {
  const out: FileIn[] = [];
  for (const e of await readdir(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (skip(rel)) continue;
    if (e.isDirectory()) out.push(...(await exportOf(root, rel, skip)));
    else out.push({ path: rel, content: await readFile(join(root, rel), "utf-8") });
  }
  return out;
}

const hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cn-structure-adv-"));
  storage = new NestStorage(dir);
  await storage.init("adv");
  ctx = context(storage);
});
afterEach(async () => {
  setDefaultVaultKeyStore(null);
  await rm(dir, { recursive: true, force: true });
  for (const root of others.splice(0)) await rm(root, { recursive: true, force: true });
});

// ─── Patch application and replay ───────────────────────────────────────────

describe("patch application and replay", () => {
  const KF = "---\ntitle: v\ntype: document\nstatus: published\n---\n## Summary\nbody\n";

  it.each([
    [
      "r21 farins-e2e: hunks that insert at a line fifty million lines past the text",
      KF,
      Array.from({ length: 5 }, (_, i) => `--- v\n+++ v\n@@ -${50_000_000 + i},0 +${50_000_001 + i},1 @@\n+x${i}\n`),
    ],
    [
      "r19 patchstall-e2e: a hunk of added lines ahead of a context line found nowhere",
      `${KF}${"\n".repeat(20_000)}`,
      [`--- v\n+++ v\n@@ -1,1 +1,2001 @@\n${"+a\n".repeat(2_000)} zzz\n`],
    ],
  ])("%s, planted by an import, holds up neither verify, reconstruct nor the next update", async (_l, kf, diffs) => {
    for (const d of diffs) {
      const { result, compared } = applyPatchBounded(kf, d);
      expect(result).toBe(false);
      expect(compared).toBeLessThan(1_000);
    }
    const started = performance.now();
    const planted = await importFiles([...plantedSet("nodes/notes", "h", kf, diffs), { path: "nodes/notes/h.md", content: kf.replace("body", "live") }]);
    expect(planted.failed).toEqual([]);
    const verify = await api.run<{ valid: boolean; errors: { document?: string }[] }>("context_verify", {}, ctx);
    expect(verify.valid).toBe(false);
    expect(verify.errors.some((e) => e.document === "nodes/notes/h")).toBe(true);
    const err = await refusal("context_reconstruct", { id: "nodes/notes/h", version: diffs.length + 1 });
    expect(err.code).toBe("RECONSTRUCTION_FAILED");
    // The rules come in afterwards: the head no longer rebuilds, so the edit is
    // judged in full — and it conforms.
    await writeConfig(SUMMARY);
    const update = await api.run<{ status: string }>("context_update", { id: "nodes/notes/h", content: "## Summary\ny\n" }, ctx);
    expect(update.status).toBe("published");
    // With the rules already in force the history is refused before it lands.
    const again = await importFiles(plantedSet("nodes/notes", "g", kf, diffs));
    expect(again.failed.map((f) => f.id)).toContain("nodes/notes/.versions/g/history.yaml");
    expect(again.failed[0].error).toMatch(/does not rebuild/);
    expect(await exists("nodes/notes/.versions/g/history.yaml")).toBe(false);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  // r21 fuzz: the patch round-trip property test lives in structure-rules-ops.test.ts.

  it("r21 holdplant: a review hold planted through an import never lands among the document's held edits", async () => {
    const id = "nodes/notes/d";
    await api.run("context_create", { id, title: "d", content: "## Summary\nbody\n" }, ctx);
    const sid = "s_2026-01-01T00-00-00-000Z_deadbeef";
    const meta = {
      suggestion_id: sid,
      document_id: id,
      zone: "z",
      doc_tier: "standard",
      source: "manual-suggestion",
      actor: "agent",
      detected_at: "2026-01-01T00:00:00.000Z",
      target_hash: ZERO,
      proposed_hash: ZERO,
      patch_path: `${sid}.patch`,
      note: "review-hold",
    };
    const plant = await importFiles([
      { path: `nodes/notes/_suggestions/d/${sid}.patch`, content: "--- a\n+++ b\n@@ -50000000,0 +50000001,1 @@\n+x\n" },
      { path: `nodes/notes/_suggestions/d/${sid}.meta.yaml`, content: yaml.dump(meta) },
    ]);
    expect(plant.failed).toEqual([]);
    expect(await exists("nodes/notes/_suggestions")).toBe(false);
    const held = await api.run<{ held_for_review: boolean; suggestion_id: string }>(
      "context_update",
      { id, content: "## Summary\nagent edit\n", review: true },
      ctx,
    );
    expect(held.held_for_review).toBe(true);
    expect((await listReviewHolds(storage, id)).map((x) => x.suggestion_id)).toEqual([held.suggestion_id]);
    await approveReview(storage, id, { actor: "owner" });
    expect(await readFile(join(dir, `${id}.md`), "utf-8")).toContain("agent edit");
  });

  it("r21 fmshift-hold: a held edit whose frontmatter moved on is refused as stale, and the document is left as it is", async () => {
    const id = "nodes/notes/d";
    const body = `## Summary\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}`;
    await api.run("context_create", { id, title: "d", content: body, tags: ["a"] }, ctx);
    const approved = await readFile(join(dir, `${id}.md`), "utf-8");
    await stageReviewHold(storage, { documentId: id, proposedRawContent: approved.replace("line 20", "HELD 20"), actor: "agent" });
    await api.run("context_update", { id, description: "a new description line" }, ctx);
    const before = await readFile(join(dir, `${id}.md`), "utf-8");
    await expect(approveReview(storage, id, { actor: "owner" })).rejects.toThrow(/stale/);
    expect(await readFile(join(dir, `${id}.md`), "utf-8")).toBe(before);
  });

  it.each([["v2.diff"], ["v2.md"], ["v11.md"]])(
    "r10 / r12 orphan: a %s planted ahead of a document's history never poisons its next version",
    async (artifact) => {
      await writeConfig(SUMMARY);
      const id = "nodes/notes/victim";
      await api.run("context_create", { id, title: "victim", content: "## Summary\nv1\n" }, ctx);
      const planted = await importFiles([
        { path: `nodes/notes/.versions/victim/${artifact}`, content: "--- planted\n+++ planted\n@@ -1,1 +1,1 @@\n-x\n+PLANTED\n" },
      ]);
      expect(planted.failed).toEqual([]);
      const next = await api.run<{ version: number; status: string }>("context_update", { id, content: "## Summary\nv2 legit\n" }, ctx);
      expect(next.status).toBe("published");
      const back = await api.run<{ content: string }>("context_reconstruct", { id, version: next.version }, ctx);
      expect(back.content).toContain("v2 legit");
      expect(back.content).not.toContain("PLANTED");
      const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, ctx);
      expect(verify.valid, JSON.stringify(verify.errors)).toBe(true);
    },
  );
});

// ─── Read budget ────────────────────────────────────────────────────────────

describe("version files that are not regular files", () => {
  // r23 fifo: only the reads that judge rules refused a non-regular version
  // file. With a FIFO at v1.md, context_verify, context_reconstruct and
  // context_update hung forever, the writes holding the vault lock. Every
  // version-file read now opens without blocking and judges the open handle.
  it.skipIf(process.platform === "win32")("r23 fifo: a FIFO in a version file's place never hangs verify, reconstruct or update", async () => {
    const { execFileSync } = await import("node:child_process");
    const id = "nodes/notes/f";
    await api.run("context_create", { id, title: "f", content: "## Summary\nv1\n" }, ctx);
    await api.run("context_update", { id, content: "## Summary\nv2\n" }, ctx);
    const v1 = join(dir, "nodes/notes/.versions/f/v1.md");
    await rm(v1);
    execFileSync("mkfifo", [v1]);
    const settled = (p: Promise<unknown>) =>
      Promise.race([p.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("hung"), 3_000))]);
    expect(await settled(api.run("context_verify", {}, ctx))).toBe("settled");
    expect(await settled(api.run("context_reconstruct", { id, version: 1 }, ctx))).toBe("settled");
    expect(await settled(api.run("context_update", { id, content: "## Summary\nv3\n" }, ctx))).toBe("settled");
    const verify = await api.run<{ valid: boolean }>("context_verify", {}, ctx);
    expect(verify.valid).toBe(false);
  });
});

describe("sealed version files outside the replayed range", () => {
  // FINDING (r23 outrange, open — PRD §10.1 known items): an import whose
  // history.yaml equals the one on disk judges its version files by the one
  // rebuild of the head, which replays from the last keyframe. A file before
  // that (v1.md of a 12-version history) is not judged: with overwrite it
  // replaces the sealed file with other bytes, and only verify then reports
  // it (content_hash_mismatch). Same on 39b3863. Repro: 12 versions, import
  // { overwrite: true } the same history.yaml plus a v1.md with other text.
  it.fails("r23 outrange: an import never replaces a sealed version file with other bytes", async () => {
    const id = "nodes/notes/long";
    await api.run("context_create", { id, title: "long", content: "## Summary\nv1\n" }, ctx);
    for (let v = 2; v <= 12; v++) await api.run("context_update", { id, content: `## Summary\nv${v}\n` }, ctx);
    const store = "nodes/notes/.versions/long";
    const sealed = await readFile(join(dir, store, "v1.md"), "utf-8");
    const history = await readFile(join(dir, store, "history.yaml"), "utf-8");
    await importFiles(
      [
        { path: `${store}/history.yaml`, content: history },
        { path: `${store}/v1.md`, content: sealed.replace("v1", "tampered") },
      ],
      { overwrite: true },
    );
    expect(await readFile(join(dir, store, "v1.md"), "utf-8")).toBe(sealed);
  });
});

describe("staged edits", () => {
  // r23 weak test: the round-trip property test checked applyPatchBounded,
  // not the path a staged edit takes — staged through storage, read back,
  // applied by applyStagedEdit.
  const CASES: Array<[string, string, string]> = [
    ["LF", "---\ntitle: a\n---\none\ntwo\n", "---\ntitle: a\n---\none\n2\n"],
    ["CRLF", "---\r\ntitle: a\r\n---\r\none\r\ntwo\r\n", "---\r\ntitle: a\r\n---\r\none\r\n2\r\n"],
    ["CR only", "---\rtitle: a\r---\rone\rtwo\r", "---\rtitle: a\r---\rone\r2\r"],
    ["BOM", "\uFEFF---\ntitle: a\n---\none\n", "\uFEFF---\ntitle: a\n---\none\nmore\n"],
    ["--- lines in the body", "---\ntitle: a\n---\n--- x\n+++ y\n@@ z\n", "---\ntitle: a\n---\n--- x\n+++ w\n@@ z\n"],
    ["frontmatter only", "---\ntitle: a\n---\nbody\n", "---\ntitle: a\ndescription: d\n---\nbody\n"],
    ["no final newline", "---\ntitle: a\n---\nbody", "---\ntitle: a\n---\nbody\nmore"],
  ];
  it.each(CASES)("r23 staged: an edit staged over %s applies back to exactly what it proposed", async (_l, a, b) => {
    const { stageSuggestion, readSuggestion, applyStagedEdit } = await import("../suggestions.js");
    const { meta } = await stageSuggestion({
      storage,
      documentId: "nodes/notes/s",
      approvedRawContent: a,
      proposedRawContent: b,
      source: "out-of-band-edit",
      actor: "x",
      docTier: "standard",
    });
    const sug = await readSuggestion(storage, "nodes/notes/s", meta.suggestion_id);
    expect(applyStagedEdit(a, sug!)).toBe(b);
  });

  it("r23 staged: a held edit to a CRLF body is approved with the body it proposed", async () => {
    const { approveReview } = await import("../review.js");
    const id = "nodes/notes/crlf";
    await api.run("context_create", { id, title: "crlf", content: "## Summary\r\none\r\ntwo\r\n" }, ctx);
    await api.run("context_update", { id, content: "## Summary\r\none\r\n2\r\n", review: true }, ctx);
    await approveReview(storage, id, { actor: "owner" });
    const got = await api.run<{ body: string }>("context_get", { id }, ctx);
    expect(got.body.replace(/\r\n/g, "\n")).toContain("one\n2");
  });
});

describe("read budget", () => {
  // Review of 7016294: replayEveryVersion read up to the whole import budget
  // for one history (512 Mi chars), and without a budget, without bound.
  it("one history's replay never reads past MAX_REPLAY_READ, budget or not", async () => {
    const half = "a".repeat(MAX_REPLAY_READ / 2 + 1);
    const versions = [1, 2].map((version) => ({ version, keyframe: true })) as Parameters<typeof replayEveryVersion>[0];
    const asked: Array<number | undefined> = [];
    const read = async (_n: number, maxBytes?: number) => (asked.push(maxBytes), half);
    expect(await replayEveryVersion(versions, read, read, undefined, () => {})).toBe(false);
    expect(await replayEveryVersion(versions, read, read, { left: 2 ** 30 }, () => {})).toBe(false);
    expect(asked.every((m) => m !== undefined && m <= BYTES_PER_CHAR * MAX_REPLAY_READ)).toBe(true);
  });

  it("r19 bigread4 / r21 readtrace: version files larger than the room left are refused unread, the first one spending the budget", async () => {
    await writeConfig(SUMMARY);
    const kf = "---\ntitle: v\ntype: document\nstatus: published\n---\n## Summary\nx\n";
    const V = "nodes/notes/.versions/h";
    await mkdir(join(dir, V), { recursive: true });
    await writeFile(join(dir, V, "v1.md"), kf, "utf-8");
    const big = "d".repeat(1_200_000);
    for (const n of [2, 3, 4]) await writeFile(join(dir, V, `v${n}.diff`), big, "utf-8");
    const history = yaml.dump({ versions: [entry(1, kf, true), entry(2, "a"), entry(3, "b"), entry(4, "c")] });
    const asked: Array<[string, number, number | undefined]> = [];
    for (const kind of ["readKeyframe", "readDiff"] as const) {
      const real = storage[kind].bind(storage);
      storage[kind] = ((id: string, v: number, opts?: { maxBytes?: number }) => {
        asked.push([kind, v, opts?.maxBytes]);
        return real(id, v, opts);
      }) as never;
    }
    const tight = { ...ctx, limits: { importReplayChars: 100_000 } };
    const r = await importFiles([{ path: `${V}/history.yaml`, content: history }], { overwrite: true }, tight);
    expect(r.failed.map((f) => f.id)).toEqual([`${V}/history.yaml`]);
    expect(r.failed[0].error).toMatch(SPLIT);
    expect(await exists(`${V}/history.yaml`)).toBe(false);
    // The keyframe, then one diff — refused unread for its size — and no more.
    expect(asked.map(([k, v]) => `${k} v${v}`)).toEqual(["readKeyframe v1", "readDiff v2"]);
    for (const [, , max] of asked) expect(max).toBeLessThanOrEqual(5 * 100_000);
  });

  it.each([["plain"], ["encrypted"]])(
    "r21 cjkbudget / encratio (%s): text of any script is read up to its character allowance, whatever its bytes",
    async (mode) => {
      if (mode === "encrypted") {
        setDefaultVaultKeyStore(new MemoryKeyStore());
        await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
      }
      // A legacy note (no Summary) that needs its head replayed: 40k characters,
      // 120 KB in UTF-8 (more sealed) — over twice a 50k-character budget in bytes.
      const id = "nodes/notes/d";
      await api.run("context_create", { id, title: "d", content: `${"漢".repeat(40_000)}\n` }, ctx);
      await api.run("context_update", { id, content: `${"漢".repeat(40_000)}\nmore\n`, publish: false }, ctx);
      await writeConfig(SUMMARY);
      const keyframe = await stat(join(dir, "nodes/notes/.versions/d/v1.md"));
      expect(keyframe.size).toBeGreaterThan(2 * 50_000);
      const tight = { ...ctx, limits: { importReplayChars: 50_000 } };
      const r = await api.run<ImportResult>("context_import", { ids: [id] }, tight);
      expect(r.failed).toEqual([]);
      expect(r.published.map((p) => p.id)).toEqual([id]);
    },
  );

  it("r15 amp3 / r17 junk: PDF bytes imported beside planted histories are judged inside the call's budget, rules or none", async () => {
    // Three histories planted in earlier calls, each with a sidecar beside it
    // and no .md: replacing a sidecar asks whether the history makes it a pdf node.
    const kf = `---\ntitle: v\ntype: document\nstatus: published\n---\n${"line\n".repeat(20_000)}`;
    const b = kf.replace(/line\n$/, "LINE\n");
    const diffs = Array.from({ length: 6 }, (_, i) => (i % 2 ? createPatch("v", b, kf) : createPatch("v", kf, b)));
    for (const k of [0, 1, 2]) {
      const r = await importFiles([...plantedSet("nodes/n", `h${k}`, kf, diffs), { path: `nodes/n/h${k}.pdf`, content: "%PDF-1.4 old" }]);
      expect(r.failed).toEqual([]);
    }
    const replace = [0, 1, 2].map((k) => ({ path: `nodes/n/h${k}.pdf`, content: "%PDF-1.4 new" }));
    const tight = { ...ctx, limits: { importReplayChars: 150_000 } };
    const cut = await importFiles(replace, { overwrite: true }, tight);
    expect(cut.failed).toHaveLength(3);
    for (const f of cut.failed) expect(f.error).toMatch(SPLIT);
    for (const k of [0, 1, 2]) expect(await readFile(join(dir, `nodes/n/h${k}.pdf`), "utf-8")).toBe("%PDF-1.4 old");
    // With room for them, the heads rebuild as documents: the bytes land, the old ones archived.
    const roomy = await importFiles(replace, { overwrite: true });
    expect(roomy.failed).toEqual([]);
    expect(await exists(`nodes/n/.versions/h0/${hex("%PDF-1.4 old")}.pdf`)).toBe(true);
  });
});

// ─── Import path rules ──────────────────────────────────────────────────────

describe("import path rules", () => {
  const ZWSP = "\u200B";
  /** Each path's verdict, and the vault must still create, edit and verify after it. */
  it.each([
    [".versions", "refused"],
    ["nodes/.versions", "refused"],
    ["nodes/notes/.versions", "refused"],
    ["nodes/.VERSIONS", "refused"],
    ["nodes/.versions.", "refused"],
    ["nodes/.versions/doc", "refused"],
    [".versions/doc", "refused"],
    ["nodes/.versions/doc.md", "refused"],
    [".versions/chain_events.yaml", "refused"],
    [".versions/Context_History.yaml", "refused"],
    [".versions/context_history.yaml/x", "refused"],
    [".versions/chain_events.yaml/x", "refused"],
    [".versions/context_latest.yaml/v1.md", "refused"],
    [".versions/.hidden/v1.md", "refused"],
    ["nodes/.versions/.x/history.yaml", "refused"],
    ["nodes/.versions/..x/v1.md", "refused"],
    ["nodes/.versions/doc/a/b", "refused"],
    ["nodes/.versions/../x.md", "refused"],
    ["nodes/x/.versions/.lock/owner", "refused"],
    [".versions/context_history.yaml", "lands"],
    [".versions/context_latest.yaml", "lands"],
    [`nodes/.versions/${ZWSP}.lock/owner`, "lands"],
    ["nodes/.versions/doc/a", "lands"],
    ["nodes/.versions/./doc/v1.md", "lands"],
    ["nodes/.versions/doc/./v1.md", "lands"],
    ["nodes/.Versions/doc/v1.md", "lands"],
    ["nodes/.versions./doc/v1.md", "lands"],
    ["nodes\\.versions\\doc\\v1.md", "lands"],
    ["nodes/_suggestions/doc", "lands"],
    ["nodes/_suggestions/.x/y", "lands"],
  ])("r19 pathrules: %j %s, and the vault keeps working", async (path, verdict) => {
    const r = await importFiles([{ path, content: "---\ntitle: v\n---\nhello\n" }], { overwrite: true });
    expect(r.failed.map((f) => f.id)).toEqual(verdict === "refused" ? [path] : []);
    for (const f of r.failed) expect(f.error).not.toContain(dir);
    expect(await exists(".versions/.lock")).toBe(false);
    expect(await exists("nodes/.versions/.lock")).toBe(false);
    await api.run("context_create", { id: "nodes/doc", title: "after", content: "y\n" }, ctx);
    await api.run("context_update", { id: "nodes/doc", content: "z\n" }, ctx);
    const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, ctx);
    expect(verify.valid, JSON.stringify(verify.errors)).toBe(true);
  });

  it.each([
    [".versions\\context_history.yaml\\x", true],
    ["./.versions/context_history.yaml/x", true],
    [".versions/context_history.yaml /x", true],
    [".versions /context_history.yaml/x", true],
    [".versions/chain_events.yaml../x", true],
    [".versions./chain_events.yaml/x", true],
    ["/.versions/chain_events.yaml/x", true],
    [".versions//chain_events.yaml/x", true],
    [".versions/CONTEXT_LATEST.YAML/x", false],
    [".versions/chain_events.yaml::$DATA/x", false],
    [".versions/\uFF23\uFF28\uFF21\uFF29\uFF2E_events.yaml/x", false],
    [".versions/chain_events.yaml\u0307/x", false],
  ])("r21 ledger2 / r19 cesquat: %j never puts a folder in a root ledger's place", async (path, refused) => {
    await api.run("context_create", { id: "nodes/seed", title: "seed", content: "s\n" }, ctx);
    const r = await importFiles([{ path, content: "x" }], { overwrite: true });
    if (refused) expect(r.failed.map((f) => f.id)).toEqual([path]);
    for (const ledger of ["context_history.yaml", "context_latest.yaml", "chain_events.yaml"]) {
      const s = await stat(join(dir, ".versions", ledger)).catch(() => null);
      expect(s === null || s.isFile(), ledger).toBe(true);
    }
    // Checkpoints and forgets still write their ledgers.
    const made = await api.run<{ id: string }>("context_create", { id: "nodes/after", title: "after", content: "y\n" }, ctx);
    await api.run("context_forget", { id: made.id, reason_code: "user_request" }, ctx);
    expect((await stat(join(dir, ".versions", "chain_events.yaml"))).isFile()).toBe(true);
  });

  it("r19 ledgersquat: a flat vault's document named after a root ledger takes no ledger's place", async () => {
    const { root, c } = await freshVault("obsidian");
    for (const name of ["context_history.yaml", "context_latest.yaml", "chain_events.yaml"]) {
      await api.run("context_create", { id: name, title: "t", content: "y\n" }, c);
    }
    const made = await api.run<{ id: string }>("context_create", { id: "notes/other", title: "o", content: "y\n" }, c);
    await api.run("context_forget", { id: made.id, reason_code: "user_request" }, c);
    for (const ledger of ["context_history.yaml", "context_latest.yaml", "chain_events.yaml"]) {
      expect((await stat(join(root, ".versions", ledger))).isFile(), ledger).toBe(true);
    }
  });

  it.each([
    ["slashes", (n: number) => `nodes/a${"/".repeat(n)}x.md`, "lands"],
    ["dashes", (n: number) => `nodes/a${"-".repeat(n)}x.md`, "refused"],
    ["dots", (n: number) => `nodes/a${".".repeat(n)}x.md`, "refused"],
    ["spaces", (n: number) => `nodes/a${" ".repeat(n)}x.md`, "lands"],
    ["underscores", (n: number) => `nodes/a${"_".repeat(n)}x.md`, "refused"],
    ["colons", (n: number) => `nodes/a${":".repeat(n)}x.md`, "lands"],
    [".md suffixes", (n: number) => `nodes/a${".md".repeat(n / 3)}x.md`, "refused"],
    ["nested stores", (n: number) => `nodes/a/${".versions/".repeat(n / 10)}x/history.yaml`, "refused"],
    ["./ segments", (n: number) => `nodes/${"./".repeat(n / 2)}x.md`, "lands"],
    ["dot-space runs", (n: number) => `${" .".repeat(n / 2)}x/a.md`, "lands"],
  ])("r8 pathredos / redos: a 100k-character run of %s in an imported path is decided at once", async (_l, make, verdict) => {
    await writeConfig({ structure: { enforce: true }, folders: { notes: {} } });
    const path = make(100_000);
    const started = performance.now();
    const r = await importFiles([{ path, content: "---\ntitle: a\n---\nb\n" }]);
    expect(r.failed.map((f) => f.id)).toEqual(verdict === "refused" ? [path] : []);
    for (const f of r.failed) {
      expect(f.error).not.toContain(dir);
      expect(f.error.length).toBeLessThan(1_000);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it.each([
    ["a slash run", `nodes/${"a/".repeat(100_000)}.versions/x`],
    ["dots", `nodes/${".".repeat(200_000)}x`],
    ["spaces", `nodes/${" ".repeat(200_000)}x`],
    ["colons", `nodes/${":".repeat(200_000)}x`],
    ["tildes", `nodes/${"~".repeat(200_000)}x`],
    ["a dotted machinery name", `nodes/.versions${".".repeat(200_000)}/x`],
  ])("r8 bigdel: deleting, forgetting or reading an id of %s fails at once, briefly, without the vault path", async (_l, id) => {
    for (const op of ["context_delete", "context_forget", "context_get"]) {
      const err = await refusal(op, { id, ...(op === "context_forget" ? { reason_code: "legal" } : {}) });
      expect(err.code, op).toBe("INVALID_DOCUMENT_ID");
      expect(err.message.length, op).toBeLessThan(400);
      expect(err.message, op).not.toContain(dir);
    }
  });

  it("r10 fp: names that only look like vault machinery land like any other file", async () => {
    const paths = [
      ".obsidian/app.json",
      ".trash/x.md",
      "notes/.attachments/img.png",
      ".github/workflows/ci.yml",
      ".versions-old/x.txt",
      "_suggestions_backup/x.txt",
      "notes/.context-notes/x.txt",
      "notes/.Versioned/x.txt",
      "Ünïcode/.ñ/x.txt",
      "notes/.v ersions/x.txt",
    ];
    const { c } = await freshVault("obsidian");
    const r = await importFiles(paths.map((path) => ({ path, content: "x" })), {}, c);
    expect(r.failed).toEqual([]);
    expect(r.written).toBe(paths.length);
  });

  it.skipIf(process.platform === "win32")(
    "r10 tsurf: no write surface reaches sealed history through an 8.3-style alias of .versions",
    async () => {
      const { publishDocument, publishDocuments } = await import("../publish.js");
      const { czarDirectEdit } = await import("../index.js");
      await api.run("context_create", { id: "nodes/notes/victim", title: "victim", content: "## Summary\nok\n" }, ctx);
      await api.run("context_update", { id: "nodes/notes/victim", content: "## Summary\nok2\n" }, ctx);
      const { symlink } = await import("node:fs/promises");
      // A symlink stands in for an NTFS short name: VERSIO~1 resolving to .versions.
      await symlink(join(dir, "nodes/notes/.versions"), join(dir, "nodes/notes/VERSIO~1"));
      const store = "nodes/notes/.versions/victim";
      const snapshot = async () => (await exportOf(dir, store)).map((f) => `${f.path}:${hex(f.content)}`).sort();
      const before = await snapshot();
      const A = "nodes/notes/VERSIO~1/victim/v1";
      const raw = "---\ntitle: evil\ntype: document\nstatus: published\n---\nevil\n";
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ["context_publish", () => api.run("context_publish", { id: A }, ctx)],
        ["context_update publish: false", () => api.run("context_update", { id: A, content: "evil", publish: false }, ctx)],
        ["publishDocument", () => publishDocument(storage, A, { editedBy: "x" })],
        ["czarDirectEdit", () => czarDirectEdit({ storage, rbac: ALLOW, documentId: A, newRawContent: raw, actor: "czar", zone: "z" })],
      ];
      for (const [label, attempt] of attempts) await expect(attempt(), label).rejects.toThrow(/reserved/);
      for (const r of [await api.run<ImportResult>("context_import", { ids: [A] }, ctx), await publishDocuments(storage, [A], { editedBy: "x" })]) {
        expect(r.failed.map((f) => f.id)).toEqual([A]);
        expect(r.failed[0].error).toMatch(/reserved/);
      }
      // An imported file through the alias is renamed off it, never written through it.
      const via = await importFiles([{ path: "nodes/notes/VERSIO~1/victim/v9.md", content: raw }], { overwrite: true });
      expect(via.failed).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  // Review of 7016294: only a `~digit` name was resolved, so a plainly named
  // symlink or junction inside the vault (a git checkout makes one) let a
  // write land in sealed history.
  it("no write or erase reaches sealed history through a symlink or junction with an ordinary name", async () => {
    const { symlink } = await import("node:fs/promises");
    await api.run("context_create", { id: "nodes/notes/victim", title: "victim", content: "## Summary\nok\n" }, ctx);
    await symlink(join(dir, "nodes/notes/.versions"), join(dir, "nodes/notes/evil"), process.platform === "win32" ? "junction" : "dir");
    const store = "nodes/notes/.versions/victim";
    const snapshot = async () => (await exportOf(dir, store)).map((f) => `${f.path}:${hex(f.content)}`).sort();
    const before = await snapshot();
    const A = "nodes/notes/evil/victim/v1";
    await expect(api.run("context_update", { id: A, content: "evil", publish: false }, ctx)).rejects.toThrow(/reserved/);
    await expect(api.run("context_publish", { id: A }, ctx)).rejects.toThrow(/reserved/);
    await expect(api.run("context_delete", { id: A }, ctx)).rejects.toThrow(/reserved/);
    const raw = "---\ntitle: evil\ntype: document\nstatus: published\n---\nevil\n";
    await importFiles([{ path: "nodes/notes/evil/victim/v9.md", content: raw }], { overwrite: true });
    expect(await snapshot()).toEqual(before);
  });
});

// ─── PDF and sidecars ───────────────────────────────────────────────────────

describe("PDF and sidecars", () => {
  const D = "nodes/decks";
  const P1 = Buffer.from(textPdf());
  const P2 = Buffer.from(textPdfV2());
  const X = "%PDF-1.4 attacker bytes";
  const asDoc = "---\ntitle: p\ntype: document\nstatus: published\n---\nnow a plain doc\n";
  const retype = (): FileIn[] => [{ path: `${D}/p.md`, content: asDoc }, ...plantedSet(D, "p", asDoc, [])];
  const sequences: Record<string, () => FileIn[][]> = {
    "retype .md and history, then the pdf": () => [retype(), [{ path: `${D}/p.pdf`, content: X }]],
    "retype the .md alone, then the pdf": () => [[{ path: `${D}/p.md`, content: asDoc }], [{ path: `${D}/p.pdf`, content: X }]],
    "a history alone, then the pdf": () => [plantedSet(D, "p", asDoc, []), [{ path: `${D}/p.pdf`, content: X }]],
    "everything in one call": () => [[...retype(), { path: `${D}/p.pdf`, content: X }]],
    "the pdf, then a retype, then the pdf twice": () => [
      [{ path: `${D}/p.pdf`, content: X }],
      retype(),
      [{ path: `${D}/p.pdf`, content: `${X} 2` }],
      [{ path: `${D}/p.pdf`, content: `${X} 3` }],
    ],
    "other spellings of the sidecar": () => [
      [`${D}/P.PDF`, `${D}/./p.pdf`, `${D}/p.pdf.`, `${D}/p.pdf `, `${D}//p.pdf`, "nodes\\decks\\p.pdf", `/${D}/p.pdf`].map((path) => ({ path, content: X })),
    ],
    "squatting the archive slots": () => [
      [`${hex(P2)}.pdf`, `${hex(P2).toUpperCase()}.pdf`, `${hex(P2)}.pdf.`].map((n) => ({ path: `${D}/.versions/p/${n}`, content: X })),
    ],
  };

  /** Every PDF byte string the vault holds, sealed files opened. */
  async function pdfBytesIn(s: NestStorage, root: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const f of await exportOf(root, "", (rel) => rel === ".context" || rel.endsWith("/.lock"))) {
      if (!/\.pdf$/i.test(f.path)) continue;
      const archived = /^(.*)\/\.versions\/([^/]+)\/([0-9a-f]{64})\.pdf$/.exec(f.path);
      const bytes = archived ? await s.readArchivedPdf(`${archived[1]}/${archived[2]}`, archived[3]) : await s.readVaultBinary(f.path);
      if (bytes) out.add(hex(bytes));
    }
    return out;
  }

  const cases = [
    ...Object.keys(sequences).map((name) => [name, "published", false] as const),
    ...Object.keys(sequences).map((name) => [name, "draft", false] as const),
    ...["retype .md and history, then the pdf", "the pdf, then a retype, then the pdf twice"].map((name) => [name, "published", true] as const),
  ];
  it.each(cases)("r17 sc2 / r15 sc: %s (%s pdf node, encrypted: %s) never loses sealed PDF bytes", async (name, state, encrypted) => {
    await writeConfig({ structure: { enforce: true }, folders: { decks: { types: ["pdf", "document"] } } });
    if (encrypted) {
      setDefaultVaultKeyStore(new MemoryKeyStore());
      await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    }
    if (state === "draft") {
      await api.run("context_import_pdf", { id: `${D}/p`, bytes_base64: toBase64(P1), publish: false }, ctx);
    } else {
      await api.run("context_import_pdf", { id: `${D}/p`, bytes_base64: toBase64(P1) }, ctx);
      await api.run("context_import_pdf", { id: `${D}/p`, bytes_base64: toBase64(P2) }, ctx);
    }
    const sealed = state === "draft" ? [hex(P1)] : [hex(P1), hex(P2)];
    for (const files of sequences[name]()) await importFiles(files, { overwrite: true });
    const held = await pdfBytesIn(storage, dir);
    for (const s of sealed) expect(held.has(s), s).toBe(true);
  });

  it("r15 fgpdf: a forgotten PDF's bytes are refused at every spelling, extension and archive slot, and by a vault that imports the tombstones", async () => {
    await api.run("context_import_pdf", { id: `${D}/p`, bytes_base64: toBase64(P1) }, ctx);
    await api.run("context_import_pdf", { id: `${D}/p`, bytes_base64: toBase64(P2) }, ctx);
    await api.run("context_forget", { id: `${D}/p`, reason_code: "legal" }, ctx);
    for (const B of [P1, P2]) {
      for (const path of [
        `${D}/p.pdf`,
        "nodes/other/q.pdf",
        "nodes/other/Q.PDF",
        "nodes/other/q.pdf.",
        `nodes/other/.versions/q/${hex(B)}.pdf`,
        "nodes/other/q.bin",
        "nodes/other/q.txt",
        "nodes/other/q",
        "assets/q.dat",
        "nodes/other/q.pdf::$DATA",
        "nodes/other/_suggestions/q/x.pdf",
      ]) {
        const r = await importFiles([{ path, content: B.toString("utf-8") }], { overwrite: true });
        expect(r.failed.map((f) => f.id), path).toEqual([path]);
      }
    }
    const events = await readFile(join(dir, ".versions", "chain_events.yaml"), "utf-8");
    const { c } = await freshVault();
    const r = await importFiles(
      [
        { path: ".versions/chain_events.yaml", content: events },
        { path: "nodes/x/y.pdf", content: P1.toString("utf-8") },
        { path: "nodes/x/z.bin", content: P2.toString("utf-8") },
      ],
      {},
      c,
    );
    expect(r.failed.map((f) => f.id).sort()).toEqual(["nodes/x/y.pdf", "nodes/x/z.bin"]);
  });

  it.each([
    ["a published document", false],
    ["a draft with no history", false],
    ["a published document, encrypted", true],
  ] as const)("r15 comp: the bytes a companion PDF beside %s held are archived before an import replaces them", async (label, encrypted) => {
    if (encrypted) {
      setDefaultVaultKeyStore(new MemoryKeyStore());
      await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    }
    if (label.startsWith("a draft")) await importFiles([{ path: "nodes/a.md", content: "---\ntitle: a\n---\ndoc\n" }]);
    else await api.run("context_create", { id: "nodes/a", title: "a", content: "doc\n" }, ctx);
    await importFiles([{ path: "nodes/a.pdf", content: "%PDF-1.4 companion v1" }]);
    const r = await importFiles([{ path: "nodes/a.pdf", content: "%PDF-1.4 companion v2" }], { overwrite: true });
    expect(r.failed).toEqual([]);
    expect((await storage.readVaultBinary("nodes/a.pdf")).toString("utf-8")).toBe("%PDF-1.4 companion v2");
    const archived = await storage.readArchivedPdf("nodes/a", hex("%PDF-1.4 companion v1"));
    expect(archived?.toString("utf-8")).toBe("%PDF-1.4 companion v1");
  });

  it.each([[false], [true]])("r15 s11: a pdf node whose history is gone (retyped: %s) keeps its bytes, or archives them before they are replaced", async (retype) => {
    await api.run("context_import_pdf", { id: `${D}/p`, bytes_base64: toBase64(P1) }, ctx);
    await rm(join(dir, D, ".versions", "p"), { recursive: true });
    if (retype) {
      const md = join(dir, `${D}/p.md`);
      await writeFile(md, (await readFile(md, "utf-8")).replace("type: pdf", "type: document"), "utf-8");
    }
    const r = await importFiles([{ path: `${D}/p.pdf`, content: "%PDF-1.4 other" }], { overwrite: true });
    expect(r.failed.map((f) => f.id)).toEqual(retype ? [] : [`${D}/p.pdf`]);
    const live = hex(await storage.readVaultBinary(`${D}/p.pdf`));
    const archived = await storage.readArchivedPdf(`${D}/p`, hex(P1));
    expect(live === hex(P1) || (archived !== null && hex(archived) === hex(P1))).toBe(true);
  });
});

// ─── Forget and tombstones ──────────────────────────────────────────────────

describe("forget and tombstones", () => {
  /** Forget a document, import `path` over the chain-event log, then try its pre-forget copy elsewhere. */
  async function eraseTombstones(path: string, overwrite: boolean) {
    await api.run("context_create", { id: "nodes/notes/s", title: "s", content: "TOP SECRET erased by legal\n" }, ctx);
    const copy = await readFile(join(dir, "nodes/notes/s.md"), "utf-8");
    await api.run("context_forget", { id: "nodes/notes/s", reason_code: "legal" }, ctx);
    const log = await readFile(join(dir, ".versions", "chain_events.yaml"), "utf-8");
    await importFiles([{ path, content: "events: []\n" }], { overwrite });
    expect(await readFile(join(dir, ".versions", "chain_events.yaml"), "utf-8")).toBe(log);
    const back = await importFiles([{ path: "nodes/notes/s2.md", content: copy }], { overwrite: true });
    expect(back.failed.map((f) => f.id)).toEqual(["nodes/notes/s2.md"]);
    expect(await exists("nodes/notes/s2.md")).toBe(false);
  }
  const SPELLINGS = [
    "./.versions/chain_events.yaml",
    ".versions/./chain_events.yaml",
    ".Versions/chain_events.yaml",
    ".versions//chain_events.yaml",
    ".versions/chain_events.yaml.",
  ];

  it.each([".versions/chain_events.yaml", "/.versions/chain_events.yaml", "\\.versions\\chain_events.yaml"])(
    "r10 chainev: an import of %j, even with overwrite, never erases a forget's tombstone",
    (path) => eraseTombstones(path, true),
  );

  it.each(SPELLINGS)("r10 chainev: an import of %j without overwrite never erases a forget's tombstone", (path) => eraseTombstones(path, false));

  // r10 chainev (fixed in round 25): with overwrite, each of these spellings
  // was planned as .versions/chain_events.yaml and written over the vault's
  // chain-event log, erasing the forget's tombstones. The importer now folds
  // the path as the planner does (isChainEventLog) and merges it as the log.
  it.each(SPELLINGS)("r10 chainev: an import of %j with overwrite never erases a forget's tombstone", (path) => eraseTombstones(path, true));

  /** A forget record as another vault's chain-event log would carry it. */
  const forgetEvent = (docId: string, eventId = "forged-1", extra = "", hash = ZERO) =>
    `- event_id: ${eventId}\n  event_type: document.forgotten\n  document_id: ${docId}\n  actor: mallory\n  timestamp: "2026-01-01T00:00:00Z"\n` +
    `  action_metadata:\n    scope: node\n    reason_code: legal\n    content_hashes: ["${hash}"]\n${extra}`;

  // r23 forgeforget: an imported forget was re-applied to the local document
  // by document_id alone — any document, whatever it held — so a caller who
  // may import could erase what it may not forget. §6.3.4 re-applies a forget
  // to a pre-forget copy: one holding content the forget erased. A record that
  // names a document here holding none of it is refused, and not logged (its
  // path would read as forgotten, and verify would flag the live document).
  it.each([".versions/chain_events.yaml", ".Versions/chain_events.yaml."])(
    "r23 forgeforget: an imported forget naming a document here that holds none of what it erased (%j) erases nothing and is not logged",
    async (path) => {
      await api.run("context_create", { id: "nodes/notes/victim", title: "victim", content: "## Summary\nkeep me\n" }, ctx);
      const live = await readFile(join(dir, "nodes/notes/victim.md"), "utf-8");
      const log = await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8").catch(() => "");
      const r = await importFiles([{ path, content: forgetEvent("nodes/notes/victim") }]);
      expect(r.failed.map((f) => f.error).join("\n")).toMatch(/holds none of the content it erased/);
      expect(await readFile(join(dir, "nodes/notes/victim.md"), "utf-8")).toBe(live);
      expect(await exists("nodes/notes/.versions/victim/v1.md")).toBe(true);
      expect(await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8").catch(() => "")).toBe(log);
      expect((await api.run<{ valid: boolean }>("context_verify", {}, ctx)).valid).toBe(true);
    },
  );

  it("r23 forgeforget: a forget made elsewhere still erases the pre-forget copy here", async () => {
    const body = "## Summary\nTOP SECRET erased by legal\n";
    await api.run("context_create", { id: "nodes/notes/s", title: "s", content: body }, ctx);
    const { root, c } = await freshVault();
    await api.run("context_create", { id: "nodes/notes/s", title: "s", content: body }, c);
    await api.run("context_forget", { id: "nodes/notes/s", reason_code: "legal" }, c);
    const theirs = await readFile(join(root, ".versions/chain_events.yaml"), "utf-8");
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: theirs }]);
    expect(r.failed).toEqual([]);
    expect((await api.run<{ frontmatter: { status: string } }>("context_get", { id: "nodes/notes/s" }, ctx)).frontmatter.status).toBe("forgotten");
  });

  // r23 evbomb: the imported event was appended verbatim, and yaml.dump
  // (noRefs) expands aliases: a 686-character alias chain became a 105 MB
  // log that every later write read. A log whose aliases expand it past its
  // own size is refused before any of it is kept.
  it("r23 evbomb: an imported event's alias chain is never expanded into the log", async () => {
    let extra = "    x0: &a0 [y, y]\n";
    for (let i = 1; i <= 20; i++) extra += `    x${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/notes/elsewhere", "bomb", extra) }]);
    expect(r.failed.map((f) => f.error).join("\n")).toMatch(/aliases expand it/);
    expect(await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8").catch(() => "")).not.toContain("bomb");
  });

  // Review of 7016294: the hash arrays were kept as given, so aliases of one
  // large string in body_hashes were written out in full per entry.
  it("an imported forget's hash arrays never carry an aliased string into the log", async () => {
    const big = "a".repeat(100_000);
    const extra = `    pad: &s ${big}\n    body_hashes: [${Array(200).fill("*s").join(", ")}]\n`;
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/notes/elsewhere", "strbomb", extra) }]);
    expect(r.failed.map((f) => f.error).join("\n")).toMatch(/aliases expand it/);
    const log = await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8").catch(() => "");
    expect(log.length).toBeLessThan(4096);
  });

  it("an imported forget logs only sha256 hashes, once each", async () => {
    const h = `sha256:${"1".repeat(64)}`;
    const extra = `    body_hashes: ["${h}", "${h}", "not-a-hash"]\n`;
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/notes/elsewhere", "hashes", extra) }]);
    expect(r.failed).toEqual([]);
    const logged = (yaml.load(await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8")) as { event_id: string; action_metadata: { body_hashes: string[] } }[])
      .find((e) => e.event_id === "hashes")!;
    expect(logged.action_metadata.body_hashes).toEqual([h]);
  });

  // r23 evmerge: each imported event re-read, re-parsed and rewrote the whole
  // log, and each record was checked against every one before it: 5000
  // events took 338 s under the vault lock. One read and one write now.
  it("r23 evmerge: 5000 imported forgets merge in one pass", async () => {
    const events = Array.from({ length: 5000 }, (_, i) => forgetEvent(`nodes/gone/d${i}`, `e${i}`)).join("");
    const started = performance.now();
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: events }]);
    expect(r.failed).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
    const logged = yaml.load(await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8")) as { event_id: string }[];
    expect(logged.filter((e) => /^e\d+$/.test(e.event_id))).toHaveLength(5000);
  }, 30_000);

  // r27 B4 (architecture review): the log was deduplicated by event_id alone,
  // so a forged record reusing a logged id (readable from context_forget_log)
  // naming another document erased it with no audit record. A known id whose
  // record differs from the logged one is refused.
  it("r27 B4: an imported forget reusing the id of a logged event with a different record is refused and erases nothing", async () => {
    await api.run("context_create", { id: "nodes/notes/s", title: "s", content: "## Summary\nTOP SECRET erased by legal\n" }, ctx);
    await api.run("context_forget", { id: "nodes/notes/s", reason_code: "legal" }, ctx);
    await api.run("context_create", { id: "nodes/notes/b", title: "b", content: "## Summary\nkeep me\n" }, ctx);
    const log = await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8");
    const forgot = (yaml.load(log) as { event_id: string; event_type: string }[]).find((e) => e.event_type === "document.forgotten")!;
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/notes/b", forgot.event_id) }]);
    expect(r.failed.map((f) => f.error).join("\n")).toMatch(/reuses the id of a logged event/);
    expect((await api.run<{ frontmatter: { status: string } }>("context_get", { id: "nodes/notes/b" }, ctx)).frontmatter.status).not.toBe("forgotten");
    expect(await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8")).toBe(log);
    expect((await api.run<{ valid: boolean }>("context_verify", {}, ctx)).valid).toBe(true);
  });

  // FINDING (r27 B4 informed, open — PRD §10.1 known items): a forget record
  // carrying a document's own checksum — which any reader gets from
  // context_get, and which an encrypted vault keeps in plaintext — passes the
  // pre-forget-copy gate and erases the document. A record is a claim; who
  // may import one is the host's to decide (authorization), not a hash check.
  it.fails("r27 B4 informed: a forged forget carrying a live document's own checksum erases nothing", async () => {
    await api.run("context_create", { id: "nodes/notes/victim", title: "victim", content: "## Summary\nkeep me\n" }, ctx);
    const { frontmatter } = await api.run<{ frontmatter: { checksum: string } }>("context_get", { id: "nodes/notes/victim" }, ctx);
    await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/notes/victim", "informed", "", frontmatter.checksum) }]);
    expect((await api.run<{ frontmatter: { status: string } }>("context_get", { id: "nodes/notes/victim" }, ctx)).frontmatter.status).not.toBe("forgotten");
  });

  // FINDING (r27 B4 poison, open — PRD §10.1 known items): a record naming an
  // absent path is logged with whatever hashes it carries; carrying a live
  // document's checksum, it makes verify flag that document and refuses its
  // next publish. Same root: recording hashes needs authorization.
  it.fails("r27 B4 poison: a forged forget at an absent path carrying a live document's checksum never marks that document forgotten", async () => {
    const id = "nodes/notes/victim";
    await api.run("context_create", { id, title: "victim", content: "## Summary\nkeep me around\n" }, ctx);
    const { frontmatter } = await api.run<{ frontmatter: { checksum: string } }>("context_get", { id }, ctx);
    await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/gone/x", "poison", `    body_hashes: ["${frontmatter.checksum}"]\n`) }]);
    expect((await api.run<{ valid: boolean }>("context_verify", {}, ctx)).valid).toBe(true);
    await api.run("context_update", { id, content: "## Summary\nkeep me around\nstill\n" }, ctx);
  });

  // r27 M2: an imported event whose timestamp is an unquoted date (valid
  // YAML; js-yaml loads a Date) failed the event schema and was applied
  // without being logged. The Date is logged as ISO; a record that still
  // cannot be logged is refused, never applied.
  it("r27 M2: an imported forget with an unquoted timestamp is logged, or refused — never applied unlogged", async () => {
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: forgetEvent("nodes/gone/y", "dated").replace('timestamp: "2026-01-01T00:00:00Z"', "timestamp: 2026-01-01T00:00:00Z") }]);
    const log = await readFile(join(dir, ".versions/chain_events.yaml"), "utf-8").catch(() => "");
    expect(r.failed).toEqual([]);
    expect(log).toContain("event_id: dated");
    expect(log).toContain("2026-01-01T00:00:00.000Z");
  });

  // r24 B5 scope: the engine forgets whole documents (§6.3); a record scoped
  // to versions named a live document and erased all of it. Such a record is
  // recorded (what it erased stays refused) but never applied to a live
  // document here, and the import says so.
  it("r24 B5 scope: an imported forget scoped to versions never erases a whole live document", async () => {
    const id = "nodes/notes/victim";
    await api.run("context_create", { id, title: "victim", content: "## Summary\nkeep me around\n" }, ctx);
    const { frontmatter } = await api.run<{ frontmatter: { checksum: string } }>("context_get", { id }, ctx);
    const record = forgetEvent(id, "scoped", "    versions: [1]\n", frontmatter.checksum).replace("scope: node", "scope: versions");
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: record }]);
    expect(r.failed.map((f) => f.error).join("\n")).toMatch(/scoped to versions/);
    expect((await api.run<{ frontmatter: { status: string } }>("context_get", { id }, ctx)).frontmatter.status).not.toBe("forgotten");
  });

  // r28 N1 (architecture re-check): finding an erased body in a copy's sealed
  // versions rebuilt every version of the document once per imported record,
  // uncharged, under the vault lock — 200 records against a 60-version
  // document took 30 s. Each document is rebuilt once per import, charged to
  // the import's replay budget; once that is spent the rest are refused.
  it("r28 N1: many imported forgets naming one long-history document rebuild it once", async () => {
    const id = "nodes/notes/long";
    await api.run("context_create", { id, title: "long", content: "## Summary\nversion 1 of a long history\n" }, ctx);
    for (let v = 2; v <= 40; v++) await api.run("context_update", { id, content: `## Summary\nversion ${v} of a long history\n` }, ctx);
    const fake = (i: number) => `sha256:${i.toString(16).padStart(64, "0")}`;
    const records = Array.from({ length: 200 }, (_, i) => forgetEvent(id, `n1-${i}`, `    body_hashes: ["${fake(i + 1)}"]\n`, fake(10_000 + i))).join("");
    const started = performance.now();
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: records }]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(r.failed).toHaveLength(200);
    expect((await api.run<{ frontmatter: { status: string } }>("context_get", { id }, ctx)).frontmatter.status).not.toBe("forgotten");
  }, 60_000);

  // r28 N1 (re-check of e78f66c): the rebuild ran reconstructVersion once
  // per version — each replaying every diff since the keyframe — and charged
  // only the rebuilt text: an imported history with one keyframe and 600
  // versions made one forget record cost 31.7 s. One forward pass now, each
  // artifact read once and each patch applied once, charged as it is spent.
  it("r28 N1: one forget record naming a planted 600-version history is checked in one pass", async () => {
    const kf = `---\ntitle: planted\n---\n${"line of planted text\n".repeat(200)}`;
    const b = `${kf}one more line\n`;
    const diffs = Array.from({ length: 599 }, (_, i) => (i % 2 ? createPatch("v", b, kf) : createPatch("v", kf, b)));
    const planted = await importFiles([
      ...plantedSet("nodes/notes", "planted", kf, diffs),
      { path: "nodes/notes/planted.md", content: "---\ntitle: planted\ntype: document\n---\nlive body of the planted note\n" },
    ]);
    expect(planted.failed).toEqual([]);
    const started = performance.now();
    const r = await importFiles([
      { path: ".versions/chain_events.yaml", content: forgetEvent("nodes/notes/planted", "one", `    body_hashes: ["${ZERO}"]\n`, `sha256:${"2".repeat(64)}`) },
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(r.failed).toHaveLength(1);
  }, 120_000);

  // r28 N1 (QA re-check of e78f66c): the per-import cache was keyed by the
  // record's spelling of the id. On a file system that ignores case,
  // `nodes/notes/HOT` and `Nodes/Notes/hot` read the same document and history,
  // so each spelling rebuilt every version again. The cache is keyed by the
  // spelling on disk (resolveDocumentIdCasing). Simulated here: every read
  // folds the id's case, as such a file system resolves it.
  it("r28 N1: case variants of one document's id rebuild its versions once", async () => {
    const { applyImportedTombstones } = await import("../forget.js");
    const { buildTombstoneIndex } = await import("../tombstones.js");
    const id = "nodes/notes/hot";
    await api.run("context_create", { id, title: "hot", content: "## Summary\nversion 1 of the hot note\n" }, ctx);
    for (let v = 2; v <= 12; v++) await api.run("context_update", { id, content: `## Summary\nversion ${v} of the hot note\n` }, ctx);
    const folding = new NestStorage(dir);
    const fold = (x: string) => x.toLowerCase();
    let artifactReads = 0;
    const s = folding as unknown as Record<string, (...a: unknown[]) => unknown>;
    // readDocument answers with the id it was asked for, as on such a file system.
    const readDocument = s.readDocument.bind(folding);
    s.readDocument = async (x: unknown, ...rest: unknown[]) => ({ ...(await readDocument(fold(String(x)), ...rest) as object), id: String(x) });
    const readHistory = s.readHistory.bind(folding);
    s.readHistory = (x: unknown, ...rest: unknown[]) => readHistory(fold(String(x)), ...rest);
    for (const m of ["readKeyframe", "readDiff"]) {
      const orig = s[m].bind(folding);
      s[m] = (x: unknown, ...rest: unknown[]) => {
        artifactReads++;
        return orig(fold(String(x)), ...rest);
      };
    }
    s.resolveDocumentIdCasing = async (x: unknown) => fold(String(x));
    const spellings = ["nodes/notes/HOT", "Nodes/notes/hot", "nodes/Notes/hot", "NODES/NOTES/HOT", "nodes/notes/Hot", "nodes/notes/hOt"];
    const events = spellings.map((docId, i) =>
      yaml.load(forgetEvent(docId, `case-${i}`, `    body_hashes: ["${ZERO}"]\n`, `sha256:${String(i + 3).repeat(64)}`)),
    ).flat();
    const { refused } = await applyImportedTombstones(folding, events, buildTombstoneIndex([]));
    expect(refused).toHaveLength(spellings.length);
    expect(artifactReads).toBeLessThanOrEqual(12);
  });

  // r28 N1b (architecture re-check of 34d5ee1): the cache key came from
  // resolveDocumentIdCasing, which lists every folder on the path, once per
  // record, under the vault lock: 5,000 records against a 20,000-file folder
  // took 79 s. The key is the file's identity, one stat per record; the
  // spelling lookup is left for file systems that report no inode.
  it("r28 N1b: many imported forgets naming one document never list its folders per record", async () => {
    const id = "nodes/notes/hot";
    await api.run("context_create", { id, title: "hot", content: "## Summary\nthe hot note body text\n" }, ctx);
    await api.run("context_update", { id, content: "## Summary\nthe hot note body text, edited\n" }, ctx);
    let listings = 0;
    const s = storage as unknown as { resolveDocumentIdCasing: (x: string) => Promise<string> };
    const resolve = s.resolveDocumentIdCasing.bind(storage);
    s.resolveDocumentIdCasing = (x) => {
      listings++;
      return resolve(x);
    };
    const records = Array.from({ length: 200 }, (_, i) => forgetEvent(id, `b-${i}`, `    body_hashes: ["${ZERO}"]\n`, `sha256:${(i + 7).toString(16).padStart(64, "0")}`)).join("");
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: records }]);
    expect(r.failed).toHaveLength(200);
    expect(listings).toBeLessThanOrEqual(1);
  });

  it("r28 N1: rebuilding a copy's versions is charged to the import's replay budget", async () => {
    const id = "nodes/notes/budgeted";
    await api.run("context_create", { id, title: "budgeted", content: "## Summary\nfirst body of this note\n" }, ctx);
    await api.run("context_update", { id, content: "## Summary\nsecond body of this note\n" }, ctx);
    const r = await importFiles(
      [{ path: ".versions/chain_events.yaml", content: forgetEvent(id, "tight", `    body_hashes: ["${ZERO}"]\n`, `sha256:${"1".repeat(64)}`) }],
      {},
      { ...ctx, limits: { importReplayChars: 10 } },
    );
    expect(r.failed.map((f) => f.error).join("\n")).toMatch(SPLIT);
  });
});

// ─── Encryption ─────────────────────────────────────────────────────────────

describe("encryption", () => {
  it.each([
    ["locked (no key)", (root: string) => new NestStorage(root, { encryption: { keyStore: new MemoryKeyStore() } })],
    ["opened with the wrong key", (root: string) => new NestStorage(root, { encryption: { kek: Buffer.alloc(32, 7) } })],
  ])("r17 encwrong: a vault %s refuses an import file by file, writes nothing, and works again with its key", async (_l, open) => {
    setDefaultVaultKeyStore(new MemoryKeyStore());
    await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await api.run("context_create", { id: "nodes/notes/a", title: "a", content: "## Summary\nv1\n" }, ctx);
    await api.run("context_update", { id: "nodes/notes/a", content: "## Summary\nv2\n" }, ctx);
    await api.run("context_import_pdf", { id: "nodes/notes/p", bytes_base64: toBase64(textPdf()) }, ctx);
    await writeConfig(SUMMARY);
    const snapshot = async () => (await exportOf(dir, "")).map((f) => `${f.path}:${hex(f.content)}`).sort();
    const before = await snapshot();
    const files: FileIn[] = [
      { path: "nodes/notes/.versions/a/history.yaml", content: "versions: []\n" },
      { path: "nodes/notes/a.md", content: "---\ntitle: a\n---\nno summary\n" },
      { path: "nodes/notes/p.pdf", content: "%PDF-1.4 other" },
      { path: "nodes/notes/new.md", content: "---\ntitle: n\n---\n## Summary\nx\n" },
    ];
    const locked = context(open(dir));
    for (const overwrite of [false, true]) {
      const r = await importFiles(files, { overwrite }, locked);
      expect(r.failed).toHaveLength(files.length);
    }
    expect(await snapshot()).toEqual(before);
    const ok = await api.run<{ status: string }>("context_update", { id: "nodes/notes/a", content: "## Summary\nv3\n" }, ctx);
    expect(ok.status).toBe("published");
  });

  it.each([["plain"], ["encrypted"]])("r15 fence5 / r12 fenceenc (%s): a lone CR that opens a fence hides the required heading on a fresh import", async (mode) => {
    if (mode === "encrypted") {
      setDefaultVaultKeyStore(new MemoryKeyStore());
      await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    }
    await writeConfig(SUMMARY);
    const twin = await importFiles([{ path: "nodes/notes/a.md", content: "---\ntitle: a\ntype: document\n---\nintro\r```\n## Summary\nx\n" }]);
    expect(twin.failed.map((f) => f.id)).toEqual(["nodes/notes/a.md"]);
    const docs = await api.run<ImportResult>("context_import", { documents: [{ title: "b", folder: "notes", content: "intro\r```\n## Summary\nx" }] }, ctx);
    expect(docs.failed.map((f) => f.title)).toEqual(["b"]);
    const glossary = await importFiles([{ path: "nodes/notes/c.md", content: "---\rtitle: c\rtype: glossary\r---\r## Summary\rx\r" }]);
    expect(glossary.failed.map((f) => f.id)).toEqual(["nodes/notes/c.md"]);
    const fine = await importFiles([{ path: "nodes/notes/d.md", content: "---\rtitle: d\rtype: document\r---\r## Summary\rx\r" }]);
    expect(fine.failed).toEqual([]);
    expect((await storage.readDocument("nodes/notes/d")).frontmatter).toMatchObject({ title: "d", type: "document" });
  });

  // r15 s3enc (fixed): an import landed a sealed .md whose authenticated text
  // was altered (here its title, in an encrypted vault's own export) verbatim,
  // and from then on context_list and context_verify failed for the whole
  // vault with DECRYPTION_FAILED. Now the import refuses a document that would
  // not read, and one damaged on disk is skipped by every crawl and named by
  // verify — while a vault with no key, or the wrong one, still refuses to
  // list rather than listing empty.
  it("r15 s3enc: a sealed document altered in transit is refused, and one damaged on disk never takes list and verify down", async () => {
    setDefaultVaultKeyStore(new MemoryKeyStore());
    await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await api.run("context_create", { id: "nodes/notes/a", title: "a", content: "body\n" }, ctx);
    await api.run("context_create", { id: "nodes/notes/b", title: "b", content: "body b\n" }, ctx);
    const raw = await readFile(join(dir, "nodes/notes/a.md"), "utf-8");
    expect(raw).toContain("title: a");
    const altered = raw.replace("title: a", "title: z");
    const r = await importFiles([{ path: "nodes/notes/a.md", content: altered }], { overwrite: true });
    expect(r.failed.map((f) => f.error).join("\n")).toMatch(/does not read as a document/);
    expect(await readFile(join(dir, "nodes/notes/a.md"), "utf-8")).toBe(raw);

    await writeFile(join(dir, "nodes/notes/a.md"), altered, "utf-8");
    const listed = (await api.run<{ documents: { id: string }[] }>("context_list", {}, ctx)).documents.map((d) => d.id);
    expect(listed).toContain("nodes/notes/b");
    expect(listed).not.toContain("nodes/notes/a");
    const verify = await api.run<{ valid: boolean; errors: { type: string; document?: string }[] }>("context_verify", {}, ctx);
    expect(verify.valid).toBe(false);
    expect(verify.errors).toContainEqual(expect.objectContaining({ type: "unreadable_document", document: "nodes/notes/a" }));
    for (const s of [
      new NestStorage(dir, { encryption: { keyStore: new MemoryKeyStore() } }),
      new NestStorage(dir, { encryption: { kek: Buffer.alloc(32, 7) } }),
    ]) {
      await expect(api.run("context_list", {}, context(s))).rejects.toMatchObject({ code: expect.stringMatching(/^VAULT_(LOCKED|KEY_MISMATCH)$/) });
    }
  });
});

// ─── Bulk publish ───────────────────────────────────────────────────────────

describe("bulk publish", () => {
  it("r21 idsperf: duplicate, invalid and missing ids are reported one by one while the rest publish, rules enforced", async () => {
    const ids = Array.from({ length: 12 }, (_, d) => `nodes/notes/d${d}`);
    await api.run("context_import", { documents: ids.map((_id, d) => ({ title: `d${d}`, folder: "notes", content: `## Summary\nv0 ${d}\n` })) }, ctx);
    for (const id of ids) {
      const file = join(dir, `${id}.md`);
      await writeFile(file, (await readFile(file, "utf-8")).replace("v0", "v1"), "utf-8");
    }
    await writeConfig(SUMMARY);
    const junk = ["../x", "nodes/notes/missing", "nodes/.versions/x", "NODES/notes/d1"];
    const r = await api.run<ImportResult>("context_import", { ids: [...ids.slice(0, 4), ...ids.slice(0, 4), ...junk, ...ids.slice(4)] }, ctx);
    expect(r.published.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(r.failed.map((f) => f.id).sort()).toEqual([...junk].sort());
    for (const f of r.failed) expect(f.error).not.toContain(dir);
  });
});

// ─── Document parsing ───────────────────────────────────────────────────────

describe("document parsing", () => {
  const n = 60_000;
  it.each([
    ["# + a run of #", `# ${"#".repeat(n)}x`, true],
    ["# + a run of [", `# ${"[".repeat(n)}`, true],
    ["# + a run of [](", `# ${"[](".repeat(n / 3)}`, true],
    ["# + spaces + CR", `# ${" ".repeat(n)}x\r`, true],
    ["# + tabs", `#\t${"\t".repeat(n)}x`, true],
    ["a setext = run", `Title\n${"=".repeat(n)}x`, true],
    ["a setext - with spaces", `Title\n-${" ".repeat(n)}x`, true],
    ["a list-ish run", `${" ".repeat(3)}-${" ".repeat(n)}x\n===`, true],
    ["# + backticks", `# ${"`".repeat(n)}x`, true],
    ["a run of fences", `${"```".repeat(n / 3)}\n`, false],
    ["many # lines", "# a\n".repeat(n / 4), true],
    ["# + *_~", `# ${"*_~".repeat(n / 3)}`, true],
    ["a run of comment openers", "<!--".repeat(n / 4), false],
    ["a run of [[", "[[".repeat(n / 2), true],
  ])("r8 bodyredos: a body with %s is judged in linear time — and still judged", async (_l, body, keepsSummary) => {
    await writeConfig(SUMMARY);
    const started = performance.now();
    await api.run("context_create", { id: "nodes/notes/h", title: "h", content: `## Summary\nok\n${body}\n` }, ctx);
    // Moved below the pathological text, the heading counts only where that text leaves it a heading.
    const moved = api.run("context_update", { id: "nodes/notes/h", content: `${body}\n## Summary\n` }, ctx);
    if (keepsSummary) await moved;
    else await expect(moved).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("r19 aliasbomb: frontmatter whose aliases unfold to 2^24 nodes imports, publishes, lists, searches and verifies", async () => {
    let fm = "title: t\nx0: &a0 [1, 2]\n";
    for (let i = 1; i <= 24; i++) fm += `x${i}: &a${i} [*a${i - 1}, *a${i - 1}]\n`;
    const started = performance.now();
    for (const field of ["meta", "tags"]) {
      const id = `nodes/notes/${field}`;
      expect((await importFiles([{ path: `${id}.md`, content: `---\n${fm}${field}: *a24\n---\nbody\n` }])).failed).toEqual([]);
      await api.run("context_publish", { id }, ctx);
      await api.run("context_update", { id, content: "new body\n" }, ctx);
    }
    expect((await api.run<{ documents: unknown[] }>("context_list", {}, ctx)).documents).toHaveLength(2);
    await api.run("context_search", { query: "body" }, ctx);
    expect((await api.run<{ valid: boolean }>("context_verify", {}, ctx)).valid).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("r15 fmfuzz: frontmatter parses the same from the raw text as from its hashed (normalized) view", async () => {
    const { parseDocument } = await import("../parser.js");
    const { normalizeForHash } = await import("../integrity.js");
    const { isDeepStrictEqual } = await import("node:util");
    const atoms = ["---", "----", "\r", "\n", "\r\n", "title: a", "type: document", "x: |", "  ---", "# c", '"', "a", " ", ":", "\uFEFF", "```", "---x", "...", 'y: "q', "\t"];
    let seed = 12345;
    const r = (k: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k;
    const parse = (text: string) => {
      try {
        const d = parseDocument("x.md", text, "x");
        return { fm: JSON.parse(JSON.stringify(d.frontmatter)), body: normalizeForHash(d.body) };
      } catch (e) {
        return { err: (e as Error).constructor.name };
      }
    };
    for (let i = 0; i < 5_000; i++) {
      let text = r(4) === 0 ? "" : `---${["\n", "\r\n", "\r"][r(3)]}`;
      for (let j = 1 + r(10); j > 0; j--) text += atoms[r(atoms.length)];
      expect(isDeepStrictEqual(parse(text), parse(normalizeForHash(text))), JSON.stringify(text)).toBe(true);
    }
  });

  it("r12 fence3: a required heading a lone CR fences off is refused through suggestion approval and an out-of-band publish too", async () => {
    await writeConfig(SUMMARY);
    const twin = "intro\r```\n## Summary\nlegit\n";
    expect((await refusal("context_create", { id: "nodes/notes/t", title: "t", content: twin })).code).toBe("VALIDATION_FAILED");
    const id = "nodes/notes/f";
    await api.run("context_create", { id, title: "f", content: "## Summary\nlegit\n" }, ctx);
    const live = await readFile(join(dir, `${id}.md`), "utf-8");
    const staged = await stageSuggestion({
      storage,
      documentId: id,
      approvedRawContent: live,
      proposedRawContent: live.replace("## Summary\nlegit\n", twin),
      source: "manual-suggestion",
      actor: "agent",
      docTier: "standard",
    });
    await expect(
      approveSuggestion({ storage, rbac: ALLOW, documentId: id, suggestionId: staged.meta.suggestion_id, actor: "owner", zone: "z" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readFile(join(dir, `${id}.md`), "utf-8")).toBe(live);
    await writeFile(join(dir, `${id}.md`), live.replace("## Summary\nlegit\n", twin), "utf-8");
    expect((await refusal("context_publish", { id })).code).toBe("VALIDATION_FAILED");
  });

  // r12 badfm / r8 badsib (fixed): an import landed a .md whose frontmatter
  // does not parse, and from then on context_list and context_search threw
  // YAMLException, and every write wrote its document and then threw from the
  // checkpoint crawl (createCheckpointFromVault → discoverDocuments) —
  // reported failed, landed on disk. Now the import refuses it, and one
  // already on disk is skipped by every crawl and named by verify.
  it("r12 badfm / r8 badsib: a document whose frontmatter does not parse is refused, and one on disk never takes list down nor turns a write into a false failure", async () => {
    const bad = "---\ntitle: [\n---\nx\n";
    const r = await importFiles([{ path: "nodes/notes/bad.md", content: bad }]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toMatch(/does not read as a document/);
    expect(await exists("nodes/notes/bad.md")).toBe(false);

    await mkdir(join(dir, "nodes/notes"), { recursive: true });
    await writeFile(join(dir, "nodes/notes/bad.md"), bad, "utf-8");
    await api.run("context_create", { id: "nodes/other/k", title: "k", content: "x" }, ctx);
    expect(await exists("nodes/other/k.md")).toBe(true);
    const listed = (await api.run<{ documents: { id: string }[] }>("context_list", {}, ctx)).documents.map((d) => d.id);
    expect(listed).toContain("nodes/other/k");
    await api.run("context_search", { query: "x" }, ctx);
    const verify = await api.run<{ errors: { type: string; document?: string }[] }>("context_verify", {}, ctx);
    expect(verify.errors).toContainEqual(expect.objectContaining({ type: "unreadable_document", document: "nodes/notes/bad" }));
  });

  // r8 jats (fixed in round 25): jatsToDocument trimmed inline
  // markup with `/\s*$/` (wrapIfText, importers/jats.ts), which retries from
  // every whitespace character of a run that does not end the text: quadratic
  // and synchronous (80k spaces ≈ 5 s here). A backtracking regex has nothing
  // to count, so the bound is on time — generous: linear handling takes
  // milliseconds. Repro: an <italic> holding 80k spaces and then "x".
  it("r8 jats: inline markup with a long run of whitespace is converted in linear time", async () => {
    const { jatsToDocument } = await import("../index.js");
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front><body><sec><title>S</title><p><italic>${" ".repeat(80_000)}x</italic></p></sec></body></article>`;
    const started = performance.now();
    jatsToDocument(xml);
    expect(performance.now() - started).toBeLessThan(500);
  });

  // r23 jatsdoi: a reference's DOI was trimmed with `/[.,;:)\]]+$/`, which
  // retries from every character of a run that does not end the text — 100k
  // dots and an "x" took 11 s, through `ctx import pubmed` on remote XML.
  it("r23 jatsdoi: a DOI with a long run of trailing punctuation is trimmed in linear time", async () => {
    const { jatsToDocument } = await import("../index.js");
    const href = `https://doi.org/10.1/${".".repeat(100_000)}x`;
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front><body><p>x</p></body><back><ref-list><ref id="r1"><mixed-citation>A <ext-link href="${href}">l</ext-link></mixed-citation></ref></ref-list></back></article>`;
    const started = performance.now();
    jatsToDocument(xml);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// ─── Locking and queueing ───────────────────────────────────────────────────

describe("locking and queueing", () => {
  it("r17 queue: a replay that throws, rejects or reads something other than text resolves null and never wedges the queue", async () => {
    const a = "---\ntitle: x\n---\nA\n";
    const h = (diffs: unknown[]) =>
      ({
        versions: [entry(1, a, true), ...diffs.map((d, i) => ({ ...entry(i + 2, typeof d === "string" ? d : "x") }))],
      }) as never;
    const malformed = "@@ -1,1 +1,1 @@\n-nope\n+x\n\\ garbage\nZZZ unknown line\n";
    const cases: Array<() => Promise<string | null>> = [
      () => sealedHead("d", h([malformed]), () => a, () => malformed),
      () => sealedHead("d", h([5]), () => a, (() => 5) as never),
      () => sealedHead("d", h(["x"]), () => a, (() => Buffer.from("x")) as never),
      () => sealedHead("d", h(["x"]), () => a, () => Promise.reject(new Error("EACCES"))),
      () =>
        sealedHead("d", h(["x"]), () => a, () => {
          throw new Error("boom");
        }),
    ];
    for (const run of cases) {
      expect(await run()).toBeNull();
      expect(await sealedHead("d", h([]), () => a, () => null)).toBe(a);
    }
    const mixed = await Promise.all(Array.from({ length: 200 }, (_, i) => (i % 3 ? cases[0]() : sealedHead("d", h([]), () => a, () => null))));
    expect(mixed.filter((x) => x === a)).toHaveLength(67);
    expect(mixed.filter((x) => x === null)).toHaveLength(133);
  });

  it.each([".versions/.Lock/owner", ".versions/.lock./owner", "./.versions/.lock/owner", ".versions/.lock/x"])(
    "r17 lockplant: %j is no way into the vault's own write lock",
    async (path) => {
      const r = await importFiles([{ path, content: "not-your-token" }], { overwrite: true });
      expect(r.failed.map((f) => f.id)).toEqual([path]);
      expect(await exists(".versions/.lock")).toBe(false);
      const started = performance.now();
      await api.run("context_create", { id: "nodes/after", title: "after", content: "y\n" }, ctx);
      expect(performance.now() - started).toBeLessThan(5_000);
    },
  );

});

// ─── Legitimate flows that must keep working ────────────────────────────────

describe("legitimate flows that must keep working", () => {
  // Review of 7016294: the new-name limit (251 bytes, room for `.pdf`) froze
  // a document already on disk with a 252-byte name (a legal 255-byte `.md`).
  it("a document already on disk under a name past the new-name limit can still be updated", async () => {
    const id = `nodes/notes/${"a".repeat(252)}`;
    await mkdir(join(dir, "nodes/notes"), { recursive: true });
    await writeFile(join(dir, `${id}.md`), "---\ntitle: long\ntype: document\nstatus: draft\n---\n\nold\n", "utf-8");
    await api.run("context_update", { id, content: "new\n", publish: false }, ctx);
    expect(await readFile(join(dir, `${id}.md`), "utf-8")).toContain("new");
    await expect(api.run("context_create", { id: `nodes/notes/${"b".repeat(252)}`, title: "x", content: "x\n" }, ctx)).rejects.toThrow(/longer than 251 bytes/);
  });

  it.each([["CRLF", "\r\n"], ["LF", "\n"]])(
    "r19 legitpatch (%s): a long history with edits at both ends and the middle reconstructs, rolls back, and takes held edits and suggestions",
    async (_l, eol) => {
      await writeConfig(SUMMARY);
      const id = "nodes/notes/big";
      const size = 2_000;
      const lines = ["## Summary", ...Array.from({ length: size }, (_, i) => `line ${i} ${"z".repeat(30)}`)];
      await api.run("context_create", { id, title: "big", content: lines.join(eol) }, ctx);
      const expected = [await readFile(join(dir, `${id}.md`), "utf-8")];
      for (let k = 1; k <= 24; k++) {
        const pos = [1, 2, Math.floor(size / 2), size - 1, size][k % 5];
        if (k % 3 === 0) lines.splice(pos, 0, `inserted ${k}`);
        else if (k % 3 === 1) lines[pos] = `changed ${k}`;
        else lines.splice(pos, 1);
        await api.run("context_update", { id, content: lines.join(eol) }, ctx);
        expected.push(await readFile(join(dir, `${id}.md`), "utf-8"));
      }
      for (let v = 1; v <= expected.length; v++) {
        const r = await api.run<{ content: string }>("context_reconstruct", { id, version: v }, ctx);
        expect(computeContentHash(r.content), `v${v}`).toBe(computeContentHash(expected[v - 1]));
      }
      const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, ctx);
      expect(verify.valid, JSON.stringify(verify.errors)).toBe(true);
      const back = await rollbackDocument({ storage, rbac: ALLOW, documentId: id, targetVersion: 21, actor: "owner", zone: "z", docTier: "standard" });
      expect(back.versionEntry.version).toBe(26);
      const approved = await readFile(join(dir, `${id}.md`), "utf-8");
      await stageReviewHold(storage, { documentId: id, proposedRawContent: approved.replace("line 1990 ", "HELD 1990 ").replace("line 5 ", "HELD 5 "), actor: "agent" });
      await approveReview(storage, id, { actor: "owner" });
      const held = await readFile(join(dir, `${id}.md`), "utf-8");
      expect(held).toContain("HELD 5 ");
      expect(held).toContain("HELD 1990 ");
      const staged = await stageSuggestion({
        storage,
        documentId: id,
        approvedRawContent: held,
        proposedRawContent: held.replace("line 500 ", "DRIFT 500 "),
        source: "manual-suggestion",
        actor: "agent",
        docTier: "standard",
      });
      await approveSuggestion({ storage, rbac: ALLOW, documentId: id, suggestionId: staged.meta.suggestion_id, actor: "owner", zone: "z" });
      expect(await readFile(join(dir, `${id}.md`), "utf-8")).toContain("DRIFT 500 ");
    },
  );

  it("r17 legit2 / r15 legitperf, legacy: an enforced vault's own export, legacy notes included, restores over itself and in chunks; a fresh vault refuses only the legacy notes", async () => {
    // Legacy content from before the rules, no Summary. (A never-published
    // legacy draft is judged as its first publish when an import overwrites
    // it — §11.1.1 — so it is not part of a round trip.)
    await api.run("context_create", { id: "nodes/notes/old", title: "old", content: "legacy, no summary v1\n" }, ctx);
    await api.run("context_update", { id: "nodes/notes/old", content: "legacy, no summary v2\n" }, ctx);
    await api.run("context_create", { id: "nodes/notes/draftold", title: "draftold", content: "legacy draft\n" }, ctx);
    await writeConfig(SUMMARY);
    await api.run("context_update", { id: "nodes/notes/old", content: "legacy, no summary v3\n" }, ctx);
    const body = (k: number) => `## Summary\n${Array.from({ length: 600 }, (_, i) => `line ${i} ${"y".repeat(40)}${i === 599 ? k : ""}`).join("\n")}`;
    for (const d of [0, 1, 2]) {
      await api.run("context_create", { id: `nodes/notes/d${d}`, title: `d${d}`, content: body(0) }, ctx);
      for (let k = 1; k < 9; k++) await api.run("context_update", { id: `nodes/notes/d${d}`, content: body(k) }, ctx);
    }
    const files = await exportOf(dir, "nodes");
    expect((await importFiles(files, { overwrite: true })).failed).toEqual([]);
    const artifacts = files.filter((f) => /\/v\d+\.(md|diff)$/.test(f.path));
    expect((await importFiles(artifacts, { overwrite: true })).failed).toEqual([]);
    expect((await importFiles(files.filter((f) => !f.path.includes(".versions")), { overwrite: true })).failed).toEqual([]);
    const relisted = await api.run<ImportResult>("context_import", { ids: ["nodes/notes/old", "nodes/notes/d0"] }, ctx);
    expect(relisted.failed).toEqual([]);
    const fresh = await freshVault();
    await writeConfig(SUMMARY, fresh.root);
    // A fresh enforced vault has no head to excuse the legacy notes: only they
    // are refused, every file of theirs and nothing else.
    const into = await importFiles(files, {}, fresh.c);
    const legacy = files.map((f) => f.path).filter((p) => /\/(\.versions\/)?(old|draftold)(\.md|\/)/.test(p));
    expect(legacy).toHaveLength(8);
    expect(into.failed.map((f) => f.id).sort()).toEqual(legacy.sort());
    for (const c of [ctx, fresh.c]) {
      const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, c);
      expect(verify.valid, JSON.stringify(verify.errors)).toBe(true);
    }
  });

  const exportSkip = (rel: string) =>
    rel === ".context" ||
    rel.endsWith(".lock") ||
    /^\.versions\/(checkpoints|context_)/.test(rel) ||
    /^(context\.yaml|CLAUDE\.md|GEMINI\.md|AGENTS\.md|CONTEXT\.md)$/.test(rel) ||
    /^\.(github|cursor|windsurf)/.test(rel);

  it.each([
    ["structured", false],
    ["obsidian", false],
    ["structured", true],
    ["obsidian", true],
  ] as const)(
    "r17 ownexp2 / r15 ownexp, ownexp-enc (%s, encrypted: %s): an export with PDFs, a held revision and forgotten nodes restores over itself, fresh and in chunks",
    async (layout, encrypted) => {
      const RULES = {
        structure: { enforce: true },
        folders: { decks: { types: ["pdf"] }, notes: { template: "n" } },
        templates: SUMMARY.templates,
      };
      if (encrypted) setDefaultVaultKeyStore(new MemoryKeyStore());
      const make = async () => {
        const v = await freshVault(layout);
        if (encrypted) await encryptVault(v.storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
        await writeConfig(RULES, v.root);
        return v;
      };
      const a = await make();
      const P = layout === "structured" ? "nodes/" : "";
      const pdf = (bytes: Uint8Array, id: string, publish = true) =>
        api.run("context_import_pdf", { id: `${P}decks/${id}`, bytes_base64: toBase64(bytes), publish }, a.c);
      await pdf(textPdf(), "p");
      await pdf(textPdfV2(), "p");
      await pdf(textPdf({ title: "held" }), "h");
      await pdf(textPdfV2({ title: "held2" }), "h", false);
      await pdf(textPdf({ title: "gone" }), "gone");
      for (const n of ["kept", "gonenote", "drafty"]) {
        await api.run("context_create", { id: `${P}notes/${n}`, title: n, content: "## Summary\nv1\n" }, a.c);
        await api.run("context_update", { id: `${P}notes/${n}`, content: "## Summary\nv2\n" }, a.c);
      }
      await api.run("context_update", { id: `${P}notes/drafty`, content: "## Summary\nunpublished v3\n", publish: false }, a.c);
      await api.run("context_forget", { id: `${P}decks/gone`, reason_code: "legal" }, a.c);
      await api.run("context_forget", { id: `${P}notes/gonenote`, reason_code: "legal" }, a.c);
      // A plaintext export: an encrypted vault is exported from a decrypted copy.
      let src = a.root;
      if (encrypted) {
        src = await mkdtemp(join(tmpdir(), "cn-structure-adv-plain-"));
        others.push(src);
        await cp(a.root, src, { recursive: true });
        await decryptVault(new NestStorage(src));
      }
      const out = (await exportOf(src, "", exportSkip)).sort((x, y) => (x.path < y.path ? -1 : 1));
      expect((await importFiles(out, { overwrite: true }, a.c)).failed).toEqual([]);
      const b = await make();
      expect((await importFiles(out, {}, b.c)).failed).toEqual([]);
      expect((await api.run<ImportResult>("context_import", { discover: true }, b.c)).failed).toEqual([]);
      const c = await make();
      const chunked: string[] = [];
      for (let i = 0; i < out.length; i += 7) chunked.push(...(await importFiles(out.slice(i, i + 7), {}, c.c)).failed.map((f) => f.id!));
      if (chunked.length) expect((await importFiles(out.filter((f) => chunked.includes(f.path)), {}, c.c)).failed).toEqual([]);
      for (const v of [a, b, c]) {
        const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, v.c);
        expect(verify.valid, JSON.stringify(verify.errors)).toBe(true);
      }
    },
  );

  it("r15 alpha / r17 conv / r15 chunks, chunk3, retry: a chunked restore converges after one re-send, in any chunk order, under enforced rules", async () => {
    const RULES = { structure: { enforce: true }, folders: { decks: { types: ["pdf", "document"] } } };
    await api.run("context_import_pdf", { id: "nodes/decks/p", bytes_base64: toBase64(textPdf()) }, ctx);
    await api.run("context_import_pdf", { id: "nodes/decks/p", bytes_base64: toBase64(textPdfV2()) }, ctx);
    await api.run("context_create", { id: "nodes/decks/n", title: "n", content: "v1\n" }, ctx);
    await api.run("context_update", { id: "nodes/decks/n", content: "v2\n" }, ctx);
    const files = (await exportOf(dir, "nodes", (rel) => rel.endsWith("INDEX.md"))).sort((x, y) => (x.path < y.path ? -1 : 1));
    const group = (p: string) => (/\/(p|n)\.md$/.test(p) ? "md" : /\/p\.pdf$/.test(p) ? "pdf" : p.endsWith("history.yaml") ? "hist" : "art");
    const plans: FileIn[][][] = [
      ...[
        ["hist", "md", "pdf", "art"],
        ["art", "hist", "md", "pdf"],
        ["md", "pdf", "hist", "art"],
        ["pdf", "art", "md", "hist"],
      ].map((order) => order.map((g) => files.filter((f) => group(f.path) === g))),
      ...Array.from({ length: files.length }, (_, k) => {
        const chunks: FileIn[][] = [];
        for (let i = 0; i < files.length; i += k + 1) chunks.push(files.slice(i, i + k + 1));
        return chunks;
      }),
    ];
    for (const [n, chunks] of plans.entries()) {
      const v = await freshVault();
      await writeConfig(RULES, v.root);
      let failed: string[] = [];
      for (const chunk of chunks) failed.push(...(await importFiles(chunk, {}, v.c)).failed.map((f) => f.id!));
      if (failed.length) failed = (await importFiles(files.filter((f) => failed.includes(f.path)), {}, v.c)).failed.map((f) => `${f.id}: ${f.error}`);
      expect(failed, `plan ${n}`).toEqual([]);
      const pub = await api.run<ImportResult>("context_import", { ids: ["nodes/decks/p", "nodes/decks/n"] }, v.c);
      expect(pub.failed, `plan ${n}`).toEqual([]);
      const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, v.c);
      expect(verify.valid, `plan ${n}: ${JSON.stringify(verify.errors)}`).toBe(true);
    }
  });

  it.each([
    ["no rules", undefined],
    ["permissive enforced rules", { structure: { enforce: true }, folders: { "**": {} } }],
  ])("r17 obs: a hand-authored Obsidian vault imports, re-imports over itself and re-sends its attachments (%s)", async (_l, rules) => {
    const { root, c } = await freshVault("obsidian");
    if (rules) await writeConfig(rules, root);
    const files: FileIn[] = [
      { path: "Daily Notes/2024-01-01.md", content: "# Jan 1\n[[My Project]]\n" },
      { path: "Projects/My Project.md", content: "---\ntags: [proj]\n---\n# My Project\n![[Image 1.png]]\n" },
      { path: "attachments/Image 1.png", content: "\x89PNG fake" },
      { path: "attachments/Spec Sheet.pdf", content: "%PDF-1.4 attachment" },
      { path: "README.md", content: "# Vault readme\n" },
      { path: "Projects/README.md", content: "# Projects\n" },
      { path: "Projects/Index.md", content: "# idx\n" },
      { path: ".obsidian/workspace.json", content: "{}" },
      { path: "Ünïcode Nötes/Café.md", content: "# café\r\nCRLF body\r\n" },
    ];
    expect((await api.run<ImportResult>("context_import", { files }, c)).failed).toEqual([]);
    expect((await api.run<ImportResult>("context_import", { files, overwrite: true }, c)).failed).toEqual([]);
    const again = await api.run<ImportResult>("context_import", { files: files.filter((f) => f.path.endsWith(".pdf")) }, c);
    expect(again.failed).toEqual([]);
  });

  it("r8 swallow: an I/O failure while scaffolding never fails the publish, and the report names what is missing", async () => {
    await writeConfig({ structure: { enforce: true }, folders: { "clients/{c}": { files: { overview: { template: "t" } } } }, templates: { t: { body: "## Summary\n" } } });
    await mkdir(join(dir, "nodes/clients/acme"), { recursive: true });
    await writeFile(join(dir, "nodes/clients/acme/d.md"), "---\ntitle: d\nstatus: draft\n---\nx\n", "utf-8");
    const listFolders = storage.listFolders.bind(storage);
    storage.listFolders = (async (o?: { folder?: string }) => {
      if (o?.folder?.startsWith("nodes/clients")) throw Object.assign(new Error("EIO: i/o error, scandir"), { code: "EIO" });
      return listFolders(o as never);
    }) as never;
    const published = await api.run<{ version: number }>("context_publish", { id: "nodes/clients/acme/d" }, ctx);
    expect(published.version).toBe(1);
    expect(await exists("nodes/clients/acme/overview.md")).toBe(false);
    storage.listFolders = listFolders;
    const report = await api.run<{ violations: { code: string; path: string }[] }>("context_structure", { report: true }, ctx);
    expect(report.violations.map((v) => [v.code, v.path])).toContainEqual(["MISSING_FILE", "clients/acme/overview"]);
  });

  it("r8 bom: rules after a byte-order mark are still enforced", async () => {
    const cfg = await readFile(join(dir, ".context/config.yaml"), "utf-8");
    await writeFile(join(dir, ".context/config.yaml"), `\uFEFFstructure: {enforce: true, closed: true}\nfolders: {notes: {types: [document]}}\n${cfg}`, "utf-8");
    const err = await refusal("context_create", { id: "nodes/evil/x", title: "x", content: "b" });
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(await exists("nodes/evil/x.md")).toBe(false);
    expect((await api.run<{ enforce: boolean }>("context_structure", {}, ctx)).enforce).toBe(true);
  });

  it.each([
    ["structure: null", "structure: null\nfolders: {notes: {}}\n", null],
    ["enforce: False (YAML boolean)", "structure: {enforce: False}\nfolders: {notes: {}}\n", null],
    ["structure: 0", "structure: 0\n", /structure/],
    ["structure: ''", "structure: ''\n", /structure/],
    ["structure: 'off'", "structure: 'off'\n", /structure/],
    ["enforce: 'false'", "structure: {enforce: 'false'}\n", /structure\.enforce/],
    ["enforce: 0", "structure: {enforce: 0}\n", /structure\.enforce/],
    ["enforce: null", "structure: {enforce: null}\nfolders: {notes: {}}\n", /structure\.enforce/],
    ["enforce: no (a string in YAML 1.2)", "structure: {enforce: no}\nfolders: {notes: {}}\n", /structure\.enforce/],
  ])("r8 sfalse: %s is %s", async (_l, extra, error) => {
    await writeFile(join(dir, ".context/config.yaml"), `version: 1\nname: adv\n${extra}`, "utf-8");
    if (error === null) {
      expect((await api.run<{ id: string }>("context_create", { id: "nodes/evil/x", title: "x", content: "b" }, ctx)).id).toBe("nodes/evil/x");
    } else {
      const err = await refusal("context_create", { id: "nodes/evil/x", title: "x", content: "b" });
      expect(err.code).toBe("CONFIG_ERROR");
      expect(err.message).toMatch(error);
      expect(await exists("nodes/evil/x.md")).toBe(false);
    }
  });

  it.each(["note", "Glossary", "GLOSSARY", "[glossary]", "snippet", '""', "{a: 1}"])(
    "r12 typerepair: type %s is refused in a glossary-only folder, and nothing lands",
    async (type) => {
      await writeConfig({ structure: { enforce: true }, folders: { terms: { types: ["glossary"] } } });
      const r = await importFiles([{ path: "nodes/terms/x.md", content: `---\ntitle: x\ntype: ${type}\nstatus: draft\n---\nbody\n` }]);
      expect(r.failed.map((f) => f.id)).toEqual(["nodes/terms/x.md"]);
      expect(await exists("nodes/terms/x.md")).toBe(false);
      const ok = await importFiles([{ path: "nodes/terms/y.md", content: "---\ntitle: y\ntype: glossary\nstatus: draft\n---\nbody\n" }]);
      expect(ok.failed).toEqual([]);
    },
  );

  it("r10 crlf3: a history git checked out with CRLF still verifies, and still grandfathers its legacy note", async () => {
    const id = "nodes/notes/old";
    await api.run("context_create", { id, title: "old", content: "legacy v1 no heading\nline2\nline3\n" }, ctx);
    await api.run("context_update", { id, content: "legacy v2 no heading\nline2\nline3\n" }, ctx);
    const V = join(dir, "nodes/notes/.versions/old");
    const history = yaml.load(await readFile(join(V, "history.yaml"), "utf-8")) as { versions: { version: number; keyframe?: boolean }[] };
    const diff = history.versions.find((e) => !e.keyframe)!.version;
    for (const f of [join(V, "v1.md"), join(V, `v${diff}.diff`), join(dir, `${id}.md`)]) {
      await writeFile(f, (await readFile(f, "utf-8")).replace(/\r?\n/g, "\r\n"), "utf-8");
    }
    await writeConfig(SUMMARY);
    const verify = await api.run<{ valid: boolean; errors: unknown[] }>("context_verify", {}, ctx);
    expect(verify.valid, JSON.stringify(verify.errors)).toBe(true);
    expect((await api.run<{ status: string }>("context_update", { id, content: "legacy v3, still no heading\n" }, ctx)).status).toBe("published");
  });

  it.each([["plain"], ["encrypted"]])("r10 grand (%s): a legacy note with 23 versions over three keyframes stays editable, publishable and restorable", async (mode) => {
    if (mode === "encrypted") {
      setDefaultVaultKeyStore(new MemoryKeyStore());
      await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    }
    const id = "nodes/notes/old";
    await api.run("context_create", { id, title: "old", content: "legacy v1 no heading\n" }, ctx);
    for (let i = 2; i <= 23; i++) await api.run("context_update", { id, content: `legacy v${i} no heading\n` }, ctx);
    await writeConfig(SUMMARY);
    await api.run("context_update", { id, content: "legacy edited, still no heading\n" }, ctx);
    const imp = await importFiles([{ path: `${id}.md`, content: "---\ntitle: old\ntype: document\nstatus: draft\n---\nreimported, no heading\n" }], { overwrite: true });
    expect(imp.failed).toEqual([]);
    await api.run("context_publish", { id }, ctx);
    await api.run("context_update", { id, content: "## Summary\nfixed\n" }, ctx);
    expect((await refusal("context_update", { id, content: "broken again\n" })).code).toBe("VALIDATION_FAILED");
  });

  it.skipIf(process.platform === "win32")(
    "r10 longid: a legacy id longer than writes accept stays readable and erasable, and is refused for writes",
    async () => {
      const { c, root } = await freshVault("obsidian");
      const id = `${Array.from({ length: 180 }, (_, i) => `seg${String(i).padStart(7, "0")}`).join("/")}/doc`;
      expect(id.length).toBeGreaterThan(1024);
      for (const [op, input] of [["context_publish", { id }], ["context_update", { id, content: "x" }]] as const) {
        expect((await refusal(op, input, c)).code, op).toBe("INVALID_DOCUMENT_ID");
      }
      // A legacy file this long cannot exist where a whole path is capped
      // shorter (macOS: 1024 bytes); there only the refusal above applies.
      const made = await mkdir(join(root, id.slice(0, id.lastIndexOf("/"))), { recursive: true }).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
          if (err.code === "ENAMETOOLONG") return false;
          throw err;
        },
      );
      if (!made) return;
      await writeFile(join(root, `${id}.md`), "---\ntitle: deep\ntype: document\nstatus: draft\n---\nbody\n", "utf-8");
      expect((await api.run<{ documents: { id: string }[] }>("context_list", {}, c)).documents.map((d) => d.id)).toContain(id);
      expect((await api.run<{ id: string }>("context_get", { id }, c)).id).toBe(id);
      for (const [op, input] of [["context_publish", { id }], ["context_update", { id, content: "x" }]] as const) {
        expect((await refusal(op, input, c)).code, op).toBe("INVALID_DOCUMENT_ID");
      }
      await api.run("context_delete", { id }, c);
      expect(await exists(`${id}.md`, root)).toBe(false);
    },
  );

  it.each([["v1.md"], ["v2.diff"]])(
    "r15 corrupt: with %s unreadable (a folder in its place), verify reports it and enforced edits are still judged",
    async (artifact) => {
      await writeConfig(SUMMARY);
      const id = "nodes/notes/x";
      await api.run("context_create", { id, title: "x", content: "## Summary\nv1\n" }, ctx);
      await api.run("context_update", { id, content: "## Summary\nv2\n" }, ctx);
      const p = join(dir, "nodes/notes/.versions/x", artifact);
      await rm(p);
      await mkdir(p);
      const verify = await api.run<{ valid: boolean; errors: { document?: string }[] }>("context_verify", {}, ctx);
      expect(verify.valid).toBe(false);
      expect(verify.errors.some((e) => e.document === id)).toBe(true);
      expect((await api.run<{ status: string }>("context_update", { id, content: "## Summary\nv3\n" }, ctx)).status).toBe("published");
      expect((await refusal("context_update", { id, content: "no summary\n" })).code).toBe("VALIDATION_FAILED");
      expect((await api.run<{ documents: unknown[] }>("context_list", {}, ctx)).documents).toHaveLength(1);
    },
  );

  // r15 corrupt (fixed): verify crawled **/.versions/*/history.yaml as files
  // only, so a folder in history.yaml's place dropped the document from the
  // crawl and verify passed green — the silent green findAllHistories'
  // onUnreadable exists to prevent. The crawl now reports a matching path that
  // is not a regular file as unreadable.
  it("r15 corrupt: a history.yaml with a folder in its place is reported by verify, never passed green", async () => {
    const id = "nodes/notes/x";
    await api.run("context_create", { id, title: "x", content: "## Summary\nv1\n" }, ctx);
    await api.run("context_update", { id, content: "## Summary\nv2\n" }, ctx);
    const p = join(dir, "nodes/notes/.versions/x/history.yaml");
    await rm(p);
    await mkdir(p);
    await expect(api.run("context_versions", { id }, ctx)).rejects.toMatchObject({ code: "CORRUPT_HISTORY" });
    const verify = await api.run<{ valid: boolean; errors: { document?: string }[] }>("context_verify", {}, ctx);
    expect(verify.valid).toBe(false);
    expect(verify.errors.some((e) => e.document === id)).toBe(true);
  });

  // r19 obsid / r21 obsforget (fixed): context_create { id: "doc" } re-roots
  // the bare id under nodes/ (normalizeDocumentId) and returns "nodes/doc",
  // but every lookup took the id as given, so context_update { id: "doc" }
  // answered DOCUMENT_NOT_FOUND. A bare id that names no document now resolves
  // to the one create gave it; a document at the bare id still wins.
  it("r19 obsid: in a flat vault a document created under a bare id is found again by that id", async () => {
    const { c } = await freshVault("obsidian");
    await api.run("context_create", { id: "doc", title: "doc", content: "one\n" }, c);
    await api.run("context_update", { id: "doc", content: "two\n" }, c);
    expect((await api.run<{ body: string }>("context_get", { id: "doc" }, c)).body).toContain("two");
    await api.run("context_forget", { id: "doc", reason_code: "user_request" }, c);
    await expect(api.run("context_get", { id: "nodes/doc" }, c)).resolves.toMatchObject({ frontmatter: { status: "forgotten" } });
  });

  it("r19 obsid: a document at the bare id itself wins over the nodes/ one", async () => {
    const { c, root: d } = await freshVault("obsidian");
    await api.run("context_create", { id: "nodes/twin", title: "twin", content: "rooted\n" }, c);
    await writeFile(join(d, "twin.md"), "---\ntitle: twin\ntype: document\nstatus: draft\n---\nflat\n", "utf-8");
    expect((await api.run<{ body: string }>("context_get", { id: "twin" }, c)).body).toContain("flat");
  });

  // Review of 7016294: `readme` resolved to the vault root's README.md, and
  // an update then wrote frontmatter into it; an unreadable root file hid
  // the nodes/ document of the same bare id.
  it("a bare id never resolves to a root scaffold file, and an unreadable root file does not hide nodes/", async () => {
    const { c, root: d } = await freshVault("obsidian");
    await writeFile(join(d, "README.md"), "# Repo readme\n", "utf-8");
    await api.run("context_create", { id: "nodes/readme", title: "readme", content: "node\n" }, c);
    await api.run("context_update", { id: "readme", content: "edited\n" }, c);
    expect(await readFile(join(d, "README.md"), "utf-8")).toBe("# Repo readme\n");
    expect((await api.run<{ body: string }>("context_get", { id: "nodes/readme" }, c)).body).toContain("edited");

    await writeFile(join(d, "notes.md"), "---\ntitle: [unclosed\n---\nbroken\n", "utf-8");
    await api.run("context_create", { id: "nodes/notes", title: "notes", content: "good\n" }, c);
    expect((await api.run<{ body: string }>("context_get", { id: "notes" }, c)).body).toContain("good");
  });
});

// ─── Architecture review of rounds 27–28 ────────────────────────────────────

describe("architecture review of rounds 27–28", () => {
  // r27 B1: a file sealed with a key this vault does not hold threw the same
  // code (DECRYPTION_FAILED) as a file that fails authentication, and
  // discovery skipped both — so a vault whose key material was replaced
  // listed empty, and the next write sealed a checkpoint holding only itself.
  it("r27 B1: a vault whose key material was replaced refuses to read, never lists empty nor seals a checkpoint without its documents", async () => {
    setDefaultVaultKeyStore(new MemoryKeyStore());
    await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await api.run("context_create", { id: "nodes/notes/a", title: "a", content: "## Summary\nx\n" }, ctx);
    await api.run("context_create", { id: "nodes/notes/b", title: "b", content: "## Summary\ny\n" }, ctx);
    const before = (await storage.readCheckpointHistory())!.checkpoints.length;
    // The obvious remedy for a lost config — encrypting again — must not mint
    // a new key over files sealed under the old one.
    const config = join(dir, ".context/encryption.yaml");
    const saved = await readFile(config, "utf-8");
    await rm(config);
    await expect(encryptVault(new NestStorage(dir), { scrypt: { N: 2 ** 10, r: 8, p: 1 } })).rejects.toMatchObject({ code: "VAULT_LOCKED" });
    expect(await exists(".context/encryption.yaml")).toBe(false);
    await writeFile(config, saved, "utf-8");
    // Another vault's key material in this vault's place: every file carries a
    // key id the config does not hold.
    const { root: other } = await freshVault();
    await encryptVault(new NestStorage(other), { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await writeFile(config, await readFile(join(other, ".context/encryption.yaml"), "utf-8"), "utf-8");
    const fresh = context(new NestStorage(dir));
    await expect(api.run("context_list", {}, fresh)).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    await api.run("context_create", { id: "nodes/notes/new", title: "n", content: "## Summary\nz\n" }, fresh).catch(() => undefined);
    const cps = (await new NestStorage(dir).readCheckpointHistory())!.checkpoints;
    for (const cp of cps.slice(before)) expect(Object.keys(cp.document_versions)).toContain("nodes/notes/a");
  });

  // r27 B2: a checkpoint sealed while a document was unreadable left it out,
  // and once the document was repaired the record stayed — verify-green and
  // wrong. An unreadable document's last sealed entry is carried forward.
  it("r27 B2: a checkpoint sealed while a document is unreadable carries that document's last sealed entry forward", async () => {
    const a = "nodes/notes/a";
    await api.run("context_create", { id: a, title: "a", content: "## Summary\nx\n" }, ctx);
    await api.run("context_create", { id: "nodes/notes/b", title: "b", content: "## Summary\ny\n" }, ctx);
    const before = (await storage.readCheckpointHistory())!.checkpoints.at(-1)!;
    const file = join(dir, `${a}.md`);
    const good = await readFile(file, "utf-8");
    await writeFile(file, good.replace("title: a", "title: ["), "utf-8");
    await api.run("context_create", { id: "nodes/notes/k", title: "k", content: "## Summary\nz\n" }, ctx);
    const sealed = (await storage.readCheckpointHistory())!.checkpoints.at(-1)!;
    expect(sealed.document_versions["nodes/notes/k"]).toBe(1);
    expect(sealed.document_versions[a]).toBe(before.document_versions[a]);
    expect(sealed.document_chain_hashes[a]).toBe(before.document_chain_hashes[a]);
    await writeFile(file, good, "utf-8");
    expect((await api.run<{ valid: boolean }>("context_verify", {}, ctx)).valid).toBe(true);
  });

  // r27 B3: context_update resolved a bare id (reading the disk) before
  // validating it, so an over-long id answered ENAMETOOLONG with the vault's
  // absolute path. The id is validated first, as every other op does.
  it.each([["over-long", "a".repeat(300)], ["a NUL", "nodes/x\u0000y"], ["traversal", "nodes/../../x"]])(
    "r27 B3: context_update refuses %s id before touching the disk, and never answers with the vault's path",
    async (_l, id) => {
      const err = await refusal("context_update", { id, content: "x" });
      expect(err.message).not.toContain(dir);
      expect(["INVALID_DOCUMENT_ID", "VALIDATION_FAILED"]).toContain(err.code);
    },
  );

  // r27 M1 / r24 B3: discovery skipped a document only when its frontmatter
  // failed to parse as YAML; frontmatter of the wrong shape (`tags: foo`,
  // which Obsidian writes; `tags: 5`; a scalar) threw a TypeError from the
  // parser and still took list, search, create and verify down. A scalar tag
  // reads as a one-tag list; any other wrong shape is one typed parse error,
  // which discovery skips and verify names.
  it.each([
    ["tags: foo", "---\ntitle: t\ntags: foo\n---\nx\n", true],
    ["tags: 5", "---\ntitle: t\ntags: 5\n---\nx\n", false],
    ["tags: {x: 1}", "---\ntitle: t\ntags: {x: 1}\n---\nx\n", false],
    ["scalar frontmatter", "---\njust a string\n---\nx\n", false],
  ])("r24 B3: a document with %s never takes list down — listed when it reads, named by verify when it does not", async (_l, raw, listed) => {
    await mkdir(join(dir, "nodes/notes"), { recursive: true });
    await writeFile(join(dir, "nodes/notes/t.md"), raw, "utf-8");
    const ids = (await api.run<{ documents: { id: string }[] }>("context_list", {}, ctx)).documents.map((d) => d.id);
    expect(ids.includes("nodes/notes/t")).toBe(listed);
    await api.run("context_search", { query: "x" }, ctx);
    await api.run("context_create", { id: "nodes/notes/k", title: "k", content: "x" }, ctx);
    const verify = await api.run<{ errors: { type: string; document?: string }[] }>("context_verify", {}, ctx);
    expect(verify.errors.some((e) => e.type === "unreadable_document" && e.document === "nodes/notes/t")).toBe(!listed);
  });

  // r24 B4: the pre-forget-copy gate compared a record's body hashes with the
  // live body only, so a copy that was edited locally — the erased body still
  // in its history — refused a legitimate forget made elsewhere (§6.3.4).
  it("r24 B4: a forget made elsewhere reaches a copy whose history holds the erased body, even after a local edit", async () => {
    const body = "## Summary\nTOP SECRET erased by legal\n";
    await api.run("context_create", { id: "nodes/notes/x", title: "x", content: body }, ctx);
    await api.run("context_update", { id: "nodes/notes/x", content: "## Summary\nedited locally\n" }, ctx);
    const { root, c } = await freshVault();
    await api.run("context_create", { id: "nodes/notes/x", title: "x", content: body }, c);
    await api.run("context_forget", { id: "nodes/notes/x", reason_code: "legal" }, c);
    const theirs = await readFile(join(root, ".versions/chain_events.yaml"), "utf-8");
    const r = await importFiles([{ path: ".versions/chain_events.yaml", content: theirs }]);
    expect(r.failed).toEqual([]);
    expect((await api.run<{ frontmatter: { status: string } }>("context_get", { id: "nodes/notes/x" }, ctx)).frontmatter.status).toBe("forgotten");
    expect(await exists("nodes/notes/.versions/x/v1.md")).toBe(false);
  });

  // r24 B6: a token format was split with `/(\{[^}]*\})/`, which rescans to
  // the end from every `{` of a run: 120k braces cost 13 s on every enforced
  // write and on `ctx structure`. Owner input, so the same class as the trims
  // fixed in rounds 22–23. A format is capped like a regex is.
  it("r24 B6: a token format of 120k braces is refused at once, and never slows a write", async () => {
    const { setStructure } = await import("../structure-store.js");
    const started = performance.now();
    await setStructure(storage, { structure: { enforce: true }, folders: { notes: { file_name: "{".repeat(120_000) } } }).catch(() => undefined);
    await api.run("context_create", { id: "nodes/notes/a", title: "a", content: "x" }, ctx).catch(() => undefined);
    await api.run("context_structure", {}, ctx).catch(() => undefined);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// ─── manifest: context.yaml and seals without a crawl ────────────────────────
// QA attacks on the manifest (manifest.ts, storage.refreshManifest) that need a
// real filesystem; the rest live in manifest.test.ts and index-equivalence.test.ts.
describe("manifest: the index without a crawl", () => {
  let root: string;
  let storage: NestStorage;
  const published = (title: string) => `---\ntitle: ${title}\ntype: document\nstatus: published\nversion: 1\n---\n\nx\n`;
  const indexedIds = async () => (await storage.readContextYaml())?.documents.map((d) => d.id) ?? [];
  // Where an id's spelling and its folder's on-disk spelling can differ.
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cn-manifest-adv-"));
    storage = new NestStorage(root);
    await storage.init("Manifest Adversarial");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // OPEN (storage.ts refreshManifest, ponytail note): a pending id spelled in
  // another case whose folder is then removed outside the engine resolves to
  // nothing, so the folder's entries stay in the index until `ctx index`.
  // `verify` reports them (stale_index). Needs an out-of-engine `rm`.
  (caseInsensitive ? it.fails : it.skip)(
    "manifest casegone: a folder removed under a case-variant pending spelling leaves the index without ctx index",
    async () => {
      await storage.writeDocument("nodes/Foo/a", published("A"));
      await storage.writeDocument("nodes/keep", published("Keep"));
      await storage.regenerateIndex();
      // An engine write under another spelling, killed before its index update…
      await storage.writeDocument("nodes/FOO/a", published("A2"));
      // …then the whole folder removed outside the engine.
      await rm(join(root, "nodes", "Foo"), { recursive: true, force: true });
      await storage.writeDocument("nodes/keep", published("Keep2"));
      await storage.regenerateIndex({ changedIds: ["nodes/keep"] });
      expect(await indexedIds()).not.toContain("nodes/Foo/a");
    },
  );

  // QA pass 4 BL2: written through a Windows 8.3 short name, a published doc
  // lands in the long-named folder; the index must list it there, never drop it.
  it.runIf(process.platform === "win32")("manifest shortname: a write through an 8.3 short name indexes the real folder", async (t) => {
    const { spawnSync } = await import("node:child_process");
    await storage.writeDocument("nodes/averylongfoldername/x", published("X"));
    await storage.regenerateIndex();
    const long = join(root, "nodes", "averylongfoldername");
    const shortPath = spawnSync("cmd", ["/d", "/s", "/c", `"for %I in ("${long}") do @echo %~sI"`], {
      encoding: "utf-8",
      windowsVerbatimArguments: true,
    }).stdout.trim();
    const short = shortPath.split("\\").pop() ?? "";
    // 8.3 names can be disabled per volume: nothing to test then.
    if (!short || short.toLowerCase() === "averylongfoldername") t.skip();
    await storage.writeDocument(`nodes/${short}/y`, published("Y"));
    await storage.regenerateIndex({ changedIds: [`nodes/${short}/y`] });
    const ids = await indexedIds();
    expect(ids).toContain("nodes/averylongfoldername/y");
    expect(ids).not.toContain(`nodes/${short}/y`);
  });
});
