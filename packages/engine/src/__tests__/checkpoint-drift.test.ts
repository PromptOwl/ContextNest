import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import {
  CheckpointManager,
  scanCheckpointDrift,
} from "../checkpoint.js";
import { computeContentHash, computeChainHash } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import type {
  DocumentHistory,
} from "../types.js";
import type { ClassificationManifest } from "../classification.js";

function buildDoc(opts: {
  title: string;
  body: string;
  version?: number;
  zone?: string;
  governance?: "primary" | "standard";
}): { raw: string; bodyHash: string } {
  const vLine = opts.version ? `version: ${opts.version}\n` : "version: 1\n";
  const zLine = opts.zone ? `zone: ${opts.zone}\n` : "";
  const gLine = opts.governance ? `governance: ${opts.governance}\n` : "";
  const placeholder =
    "---\n" +
    `title: ${opts.title}\n` +
    vLine +
    zLine +
    gLine +
    `checksum: 'sha256:${"0".repeat(64)}'\n` +
    "---\n" +
    opts.body;
  const bodyHash = computeContentHash(getChecksumContent(placeholder));
  const raw =
    "---\n" +
    `title: ${opts.title}\n` +
    vLine +
    zLine +
    gLine +
    `checksum: '${bodyHash}'\n` +
    "---\n" +
    opts.body;
  return { raw, bodyHash };
}

/** Seed a doc with v1 keyframe + history. Returns the canonical raw bytes. */
async function seedDoc(
  storage: NestStorage,
  relPath: string,
  body: string,
  fmOpts: {
    zone?: string;
    governance?: "primary" | "standard";
  } = {},
): Promise<string> {
  const { raw, bodyHash } = buildDoc({
    title: relPath,
    body,
    version: 1,
    ...fmOpts,
  });
  const filePath = join(storage.root, `${relPath}.md`);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, raw, "utf-8");

  const docName = relPath.split("/").pop()!;
  const docDir = relPath.split("/").slice(0, -1).join("/");
  const verDir = join(storage.root, docDir, ".versions", docName);
  await mkdir(verDir, { recursive: true });
  await writeFile(join(verDir, "v1.md"), raw, "utf-8");
  const chain = computeChainHash(
    null,
    bodyHash,
    1,
    "czar:vp",
    "2026-04-19T12:00:00Z",
  );
  const history: DocumentHistory = {
    keyframe_interval: 10,
    versions: [
      {
        version: 1,
        keyframe: true,
        edited_by: "czar:vp",
        edited_at: "2026-04-19T12:00:00Z",
        content_hash: bodyHash,
        chain_hash: chain,
      },
    ],
  };
  await writeFile(join(verDir, "history.yaml"), yaml.dump(history), "utf-8");
  return raw;
}

const MANIFEST: ClassificationManifest = {
  schema_version: "1.0",
  patterns: [
    { path: "nodes/strategy/", zone: "leadership", governance: "primary" },
    { path: "nodes/client/", zone: "client-acme", governance: "primary" },
    { path: "nodes/", zone: "enterprise", governance: "standard" },
  ],
};

describe("scanCheckpointDrift — Story 2.1, Story 3.1", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-ckpt-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clean vault: scanned > 0, drifted == 0, staged == 0", async () => {
    await seedDoc(storage, "nodes/clean", "body\n", {
      zone: "client-acme",
      governance: "primary",
    });
    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
    });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.drifted).toBe(0);
    expect(result.stagedCount).toBe(0);
  });

  it("single drifted doc: stages a suggestion under _suggestions/", async () => {
    const approvedRaw = await seedDoc(storage, "nodes/playbook", "v1 body\n", {
      zone: "client-acme",
      governance: "primary",
    });
    // Out-of-band edit: change body, do NOT update checksum.
    const driftedRaw = approvedRaw.replace("v1 body", "drifted body");
    await writeFile(join(root, "nodes", "playbook.md"), driftedRaw, "utf-8");

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
    });
    expect(result.drifted).toBe(1);
    expect(result.stagedCount).toBe(1);

    const entry = result.entries.find((e) => e.documentId === "nodes/playbook");
    expect(entry?.staged).toBeDefined();
    expect(entry?.staged?.source).toBe("out-of-band-edit");
    expect(entry?.staged?.doc_tier).toBe("primary");
    expect(entry?.staged?.zone).toBe("client-acme");
    expect(entry?.staged?.actor).toBe("system:checkpoint");
    expect(entry?.staged?.note).toContain("checkpoint scan");

    // Files exist on disk.
    const dir = join(root, "nodes", "_suggestions", "playbook");
    const sid = entry!.staged!.suggestion_id;
    await expect(stat(join(dir, `${sid}.patch`))).resolves.toBeDefined();
    await expect(stat(join(dir, `${sid}.meta.yaml`))).resolves.toBeDefined();
  });

  it("canonical live file remains drifted on disk — engine never auto-rewrites", async () => {
    const approvedRaw = await seedDoc(
      storage,
      "nodes/playbook",
      "v1 body\n",
      { zone: "client-acme", governance: "primary" },
    );
    const driftedRaw = approvedRaw.replace("v1 body", "user edit");
    await writeFile(join(root, "nodes", "playbook.md"), driftedRaw, "utf-8");

    await scanCheckpointDrift({ storage, actor: "system:checkpoint" });

    // Live file unchanged: still the drifted version. Approval is what
    // restores or applies — scan only captures.
    const live = await readFile(join(root, "nodes", "playbook.md"), "utf-8");
    expect(live).toContain("user edit");
  });

  it("multiple drifted docs each get their own suggestion", async () => {
    const a = await seedDoc(storage, "nodes/a", "a body\n", {
      zone: "client-acme",
      governance: "primary",
    });
    const b = await seedDoc(storage, "nodes/b", "b body\n", {
      zone: "enterprise",
      governance: "standard",
    });
    await writeFile(
      join(root, "nodes", "a.md"),
      a.replace("a body", "a drifted"),
      "utf-8",
    );
    await writeFile(
      join(root, "nodes", "b.md"),
      b.replace("b body", "b drifted"),
      "utf-8",
    );

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
    });
    expect(result.drifted).toBe(2);
    expect(result.stagedCount).toBe(2);
    const tiers = result.entries
      .filter((e) => e.staged)
      .map((e) => e.staged!.doc_tier)
      .sort();
    expect(tiers).toEqual(["primary", "standard"]);
  });

  it("skips docs with no version history (cannot diff against a chain head)", async () => {
    // Live file with valid checksum (looks fine) but no keyframe / history.
    const { raw } = buildDoc({
      title: "Orphan",
      body: "orphan body\n",
      zone: "enterprise",
      governance: "standard",
    });
    // Force a checksum mismatch so detectDrift fires.
    const driftedRaw = raw.replace("orphan body", "edited body");
    await writeFile(join(root, "nodes", "orphan.md"), driftedRaw, "utf-8");

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
    });
    const entry = result.entries.find((e) => e.documentId === "nodes/orphan");
    expect(entry?.drifted).toBe(true);
    expect(entry?.staged).toBeUndefined();
    expect(entry?.skippedReason).toBe("no-version-history");
  });

  it("skips docs that have no stored checksum (engine cannot decide drift)", async () => {
    const noChecksum =
      "---\n" +
      "title: NoCk\n" +
      "version: 1\n" +
      "zone: enterprise\n" +
      "governance: standard\n" +
      "---\n" +
      "any body\n";
    await writeFile(join(root, "nodes", "no-ck.md"), noChecksum, "utf-8");

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
    });
    const entry = result.entries.find((e) => e.documentId === "nodes/no-ck");
    expect(entry?.drifted).toBe(false);
    expect(entry?.skippedReason).toBe("no-stored-checksum");
  });

  it("resolves zone via classification manifest when frontmatter lacks it", async () => {
    // Doc has NO zone/governance in frontmatter, lives under nodes/client/
    const { raw } = buildDoc({
      title: "Implicit",
      body: "before\n",
      version: 1,
    });
    await mkdir(join(root, "nodes", "client"), { recursive: true });
    await writeFile(join(root, "nodes", "client", "deal.md"), raw, "utf-8");
    // Set up history under nodes/client/.versions/deal/
    const docName = "deal";
    const verDir = join(root, "nodes", "client", ".versions", docName);
    await mkdir(verDir, { recursive: true });
    await writeFile(join(verDir, "v1.md"), raw, "utf-8");
    const bodyHash = computeContentHash(getChecksumContent(raw));
    const chain = computeChainHash(null, bodyHash, 1, "czar", "2026-01-01T00:00:00Z");
    await writeFile(
      join(verDir, "history.yaml"),
      yaml.dump({
        keyframe_interval: 10,
        versions: [
          {
            version: 1,
            keyframe: true,
            edited_by: "czar",
            edited_at: "2026-01-01T00:00:00Z",
            content_hash: bodyHash,
            chain_hash: chain,
          },
        ],
      }),
      "utf-8",
    );
    // Drift the live file.
    await writeFile(
      join(root, "nodes", "client", "deal.md"),
      raw.replace("before", "after"),
      "utf-8",
    );

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      manifest: MANIFEST,
    });

    const entry = result.entries.find(
      (e) => e.documentId === "nodes/client/deal",
    );
    expect(entry?.staged?.zone).toBe("client-acme");
    expect(entry?.staged?.doc_tier).toBe("primary");
  });

  it("uses defaultZone fallback when no manifest and no frontmatter zone", async () => {
    const { raw } = buildDoc({
      title: "Fallback",
      body: "before\n",
      version: 1,
    });
    await writeFile(join(root, "nodes", "fb.md"), raw, "utf-8");
    const verDir = join(root, "nodes", ".versions", "fb");
    await mkdir(verDir, { recursive: true });
    await writeFile(join(verDir, "v1.md"), raw, "utf-8");
    const bodyHash = computeContentHash(getChecksumContent(raw));
    const chain = computeChainHash(null, bodyHash, 1, "x", "2026-01-01T00:00:00Z");
    await writeFile(
      join(verDir, "history.yaml"),
      yaml.dump({
        keyframe_interval: 10,
        versions: [
          {
            version: 1,
            keyframe: true,
            edited_by: "x",
            edited_at: "2026-01-01T00:00:00Z",
            content_hash: bodyHash,
            chain_hash: chain,
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(
      join(root, "nodes", "fb.md"),
      raw.replace("before", "after"),
      "utf-8",
    );

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      defaultZone: "enterprise",
      defaultGovernance: "standard",
    });
    const entry = result.entries.find((e) => e.documentId === "nodes/fb");
    expect(entry?.staged?.zone).toBe("enterprise");
    expect(entry?.staged?.doc_tier).toBe("standard");
  });

  it("skips with reason 'unresolved-zone' when no zone is derivable", async () => {
    const { raw } = buildDoc({
      title: "Unresolved",
      body: "before\n",
      version: 1,
    });
    await writeFile(join(root, "nodes", "ur.md"), raw, "utf-8");
    const verDir = join(root, "nodes", ".versions", "ur");
    await mkdir(verDir, { recursive: true });
    await writeFile(join(verDir, "v1.md"), raw, "utf-8");
    const bodyHash = computeContentHash(getChecksumContent(raw));
    const chain = computeChainHash(null, bodyHash, 1, "x", "2026-01-01T00:00:00Z");
    await writeFile(
      join(verDir, "history.yaml"),
      yaml.dump({
        keyframe_interval: 10,
        versions: [
          {
            version: 1,
            keyframe: true,
            edited_by: "x",
            edited_at: "2026-01-01T00:00:00Z",
            content_hash: bodyHash,
            chain_hash: chain,
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(
      join(root, "nodes", "ur.md"),
      raw.replace("before", "after"),
      "utf-8",
    );

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
      // No manifest, no defaultZone → cannot resolve.
    });
    const entry = result.entries.find((e) => e.documentId === "nodes/ur");
    expect(entry?.drifted).toBe(true);
    expect(entry?.skippedReason).toBe("unresolved-zone");
  });

  it("does not throw on a per-doc failure; continues to next doc", async () => {
    const a = await seedDoc(storage, "nodes/good", "approved-good-body\n", {
      zone: "enterprise",
      governance: "standard",
    });
    // Drifted but no history → causes skip not throw.
    const { raw: badRaw } = buildDoc({
      title: "Bad",
      body: "approved-bad-body\n",
      zone: "enterprise",
      governance: "standard",
    });
    await writeFile(
      join(root, "nodes", "bad.md"),
      badRaw.replace("approved-bad-body", "drifted-bad-body"),
      "utf-8",
    );
    // Drift the good doc too.
    await writeFile(
      join(root, "nodes", "good.md"),
      a.replace("approved-good-body", "drifted-good-body"),
      "utf-8",
    );

    const result = await scanCheckpointDrift({
      storage,
      actor: "system:checkpoint",
    });
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(
      result.entries.find((e) => e.documentId === "nodes/good")?.staged,
    ).toBeDefined();
    expect(
      result.entries.find((e) => e.documentId === "nodes/bad")?.skippedReason,
    ).toBe("no-version-history");
  });
});

describe("CheckpointManager.scanForDrift — convenience binding", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-cm-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("delegates to scanCheckpointDrift using the manager's storage", async () => {
    const approvedRaw = await seedDoc(storage, "nodes/x", "v1\n", {
      zone: "enterprise",
      governance: "standard",
    });
    await writeFile(
      join(root, "nodes", "x.md"),
      approvedRaw.replace("v1", "v2"),
      "utf-8",
    );
    const cm = new CheckpointManager(storage);
    const result = await cm.scanForDrift({ actor: "system:cm" });
    expect(result.stagedCount).toBe(1);
    expect(result.entries[0].staged?.actor).toBe("system:cm");
  });
});
