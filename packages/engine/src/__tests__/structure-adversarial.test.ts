/**
 * The QA rounds' adversarial probes against the structure rules (spec
 * §11.1.1) and the import, replay, sidecar and tombstone defences around
 * them, kept as tests so every attack re-runs on every PR. Each test names
 * the round and the probe that found it (`r19 bigread4` is /tmp/qa-r19's
 * bigread4.mjs). Attacks with a test in structure-rules-ops.test.ts are not
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
import { applyPatchBounded } from "../reconstruct.js";
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

  it("r21 fuzz: a patch the engine makes applies back to exactly its target, and never to a wrong text", () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const words = ["a", "b", "", "---", "## Summary", " ", "x y", "é", "\t", "\\", "+", "-", "@@ -1 +1 @@"];
    let lone = 0;
    for (let i = 0; i < 3_000; i++) {
      const mode = pick(["lf", "crlf", "mixed", "cr"]);
      const eol = () => (mode === "lf" ? "\n" : mode === "crlf" ? "\r\n" : mode === "cr" ? pick(["\r", "\n"]) : pick(["\n", "\r\n", "\r"]));
      let a = "";
      for (let j = Math.floor(rnd() * 40); j > 0; j--) a += pick(words) + eol();
      if (rnd() < 0.3) a = a.replace(/(\r\n|\r|\n)$/, "");
      const lines = a.split(/(?<=\n)/);
      for (let k = 1 + Math.floor(rnd() * 5); k > 0; k--) {
        const p = Math.floor(rnd() * (lines.length + 1));
        const o = rnd();
        if (o < 0.4) lines.splice(p, 0, pick(words) + eol());
        else if (o < 0.7) lines.splice(p, 1);
        else lines[p] = pick(words) + eol();
      }
      if (rnd() < 0.2) lines.push(pick(words));
      const b = lines.filter((x) => x !== undefined).join("");
      const { result } = applyPatchBounded(a, createPatch("v", a, b, "v1", "v2"));
      // A lone CR is no line break to the patch library, so a patch across one
      // may not apply (createVersion then writes a keyframe) — but whatever
      // applies is exactly the target.
      if (/\r(?!\n)/.test(a + b)) {
        lone++;
        if (result !== false) expect(result, JSON.stringify([a, b])).toBe(b);
      } else {
        expect(result, JSON.stringify([a, b])).toBe(b);
      }
    }
    expect(lone).toBeGreaterThan(0);
  });

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

describe("read budget", () => {
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
    for (const [, , max] of asked) expect(max).toBeLessThanOrEqual(4 * 100_000);
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

  // FINDING (r10 chainev, still open at 4336ffe): with overwrite, each of these
  // spellings is planned as .versions/chain_events.yaml ("path slugified") and
  // written verbatim over the vault's chain-event log, so the forget's
  // tombstones are gone and the pre-forget copy imports at another path. The
  // plain spelling is replayed as imported forgets instead, and holds.
  it.fails.each(SPELLINGS)("r10 chainev: an import of %j with overwrite never erases a forget's tombstone", (path) => eraseTombstones(path, true));
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

  // FINDING (r15 s3enc, still open at 4336ffe): an import lands a sealed .md
  // whose authenticated text was altered (here its title, in an encrypted
  // vault's own export) verbatim — sealed bytes are written as they come —
  // and from then on context_list and context_verify fail for the whole vault
  // with DECRYPTION_FAILED instead of reporting the one document. Repro:
  // encrypt a vault, create nodes/notes/a, re-import nodes/notes/a.md with
  // "title: a" changed to "title: z" (overwrite), run context_list.
  it.fails("r15 s3enc: a sealed document altered in transit is refused, or reported by verify — it never takes list and verify down", async () => {
    setDefaultVaultKeyStore(new MemoryKeyStore());
    await encryptVault(storage, { scrypt: { N: 2 ** 10, r: 8, p: 1 } });
    await api.run("context_create", { id: "nodes/notes/a", title: "a", content: "body\n" }, ctx);
    await api.run("context_create", { id: "nodes/notes/b", title: "b", content: "body b\n" }, ctx);
    const raw = await readFile(join(dir, "nodes/notes/a.md"), "utf-8");
    expect(raw).toContain("title: a");
    const r = await importFiles([{ path: "nodes/notes/a.md", content: raw.replace("title: a", "title: z") }], { overwrite: true });
    if (r.failed.length === 0) {
      expect((await api.run<{ documents: unknown[] }>("context_list", {}, ctx)).documents.length).toBeGreaterThan(0);
      const verify = await api.run<{ valid: boolean; errors: { document?: string }[] }>("context_verify", {}, ctx);
      expect(verify.errors.some((e) => e.document === "nodes/notes/a")).toBe(true);
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

  // FINDING (r12 badfm / r8 badsib, still open at 4336ffe): an import lands a
  // .md whose frontmatter does not parse (rules on or off), and from then on
  // context_list and context_search throw YAMLException, and every write
  // writes its document and then throws from the checkpoint crawl
  // (createCheckpointFromVault → discoverDocuments) — reported failed, landed
  // on disk. Repro: context_import files [{ path: "nodes/notes/bad.md",
  // content: "---\ntitle: [\n---\nx\n" }], then context_list; or
  // context_create nodes/other/k: throws, and k.md exists.
  it.fails("r12 badfm / r8 badsib: a document whose frontmatter does not parse never takes list down, nor turns a write into a false failure", async () => {
    const r = await importFiles([{ path: "nodes/notes/bad.md", content: "---\ntitle: [\n---\nx\n" }]);
    expect(r.failed).toEqual([]);
    const outcome = await api.run("context_create", { id: "nodes/other/k", title: "k", content: "x" }, ctx).then(
      () => "landed",
      () => "refused",
    );
    expect(outcome).toBe((await exists("nodes/other/k.md")) ? "landed" : "refused");
    await api.run("context_list", {}, ctx);
  });

  // FINDING (r8 jats / rx, still open at 4336ffe): jatsToDocument trims inline
  // markup with `/\s*$/` (wrapIfText, importers/jats.ts), which retries from
  // every whitespace character of a run that does not end the text: quadratic
  // and synchronous (80k spaces ≈ 5 s here). A backtracking regex has nothing
  // to count, so the bound is on time — generous: linear handling takes
  // milliseconds. Repro: an <italic> holding 80k spaces and then "x".
  it.fails("r8 jats: inline markup with a long run of whitespace is converted in linear time", async () => {
    const { jatsToDocument } = await import("../index.js");
    const xml = `<article><front><article-meta><title-group><article-title>T</article-title></title-group></article-meta></front><body><sec><title>S</title><p><italic>${" ".repeat(80_000)}x</italic></p></sec></body></article>`;
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
      await mkdir(join(root, id.slice(0, id.lastIndexOf("/"))), { recursive: true });
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

  // FINDING (r15 corrupt, still open at 4336ffe): verify crawls
  // **/.versions/*/history.yaml as files, so a folder in history.yaml's place
  // drops the document from the crawl and verify passes green — the silent
  // green findAllHistories' onUnreadable exists to prevent. Repro: create a
  // document, replace nodes/notes/.versions/x/history.yaml with a folder, run
  // context_verify: { valid: true, errors: [] }.
  it.fails("r15 corrupt: a history.yaml with a folder in its place is reported by verify, never passed green", async () => {
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

  // FINDING (r19 obsid / r21 obsforget, still open at 4336ffe): in a flat
  // (obsidian) vault, context_create { id: "doc" } re-roots the bare id under
  // nodes/ (normalizeDocumentId) and returns "nodes/doc", but context_update
  // { id: "doc" } then answers DOCUMENT_NOT_FOUND. The QA worked around it by
  // using the returned id.
  it.fails("r19 obsid: in a flat vault a document created under a bare id is found again by that id", async () => {
    const { c } = await freshVault("obsidian");
    await api.run("context_create", { id: "doc", title: "doc", content: "one\n" }, c);
    await api.run("context_update", { id: "doc", content: "two\n" }, c);
  });
});
