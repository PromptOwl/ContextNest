import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { runHygienistScan } from "../hygienist.js";
import { computeContentHash, computeChainHash } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import type { DocumentHistory, RbacHook } from "../types.js";
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
  const chain = computeChainHash(null, bodyHash, 1, "czar:vp", "2026-04-19T12:00:00Z");
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

const ALLOW_ALL: RbacHook = {
  isCzar: () => true,
  canIngest: () => true,
  isDocOwner: () => true,
};

const DENY_ALL: RbacHook = {
  isCzar: () => false,
  canIngest: () => false,
  isDocOwner: () => false,
};

function ingestOnly(zones: string[]): RbacHook {
  return {
    isCzar: () => false,
    canIngest: (_actor, zone) => zones.includes(zone),
    isDocOwner: () => false,
  };
}

const MANIFEST: ClassificationManifest = {
  schema_version: "1.0",
  patterns: [
    { path: "nodes/leadership/", zone: "leadership", governance: "primary" },
    { path: "nodes/client/", zone: "client-acme", governance: "primary" },
    { path: "nodes/", zone: "enterprise", governance: "standard" },
  ],
};

describe("runHygienistScan — Story 4.2, Zone §3.5", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-hyg-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clean vault: no drifts, no staging, no permission filtering", async () => {
    await seedDoc(storage, "nodes/clean", "body\n", {
      zone: "enterprise",
      governance: "standard",
    });
    const result = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
    });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.drifted).toBe(0);
    expect(result.stagedCount).toBe(0);
    expect(result.permissionFiltered).toBe(0);
  });

  it("drifted doc in ingestible zone: staged with hygienist note", async () => {
    const a = await seedDoc(storage, "nodes/playbook", "approved\n", {
      zone: "client-acme",
      governance: "primary",
    });
    await writeFile(
      join(root, "nodes", "playbook.md"),
      a.replace("approved", "user-edit"),
      "utf-8",
    );
    const result = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
    });
    const entry = result.entries.find((e) => e.documentId === "nodes/playbook");
    expect(entry?.staged).toBeDefined();
    expect(entry?.staged?.note).toContain("hygienist");
    expect(entry?.staged?.actor).toBe("system:scanner");
  });

  it("Story 4.2 NEGATIVE TEST: scanner does NOT touch a zone it cannot ingest", async () => {
    // Leadership doc — drifted on disk.
    const lead = await seedDoc(storage, "nodes/leadership-doc", "secret v1\n", {
      zone: "leadership",
      governance: "primary",
    });
    await writeFile(
      join(root, "nodes", "leadership-doc.md"),
      lead.replace("secret v1", "secret leaked"),
      "utf-8",
    );

    // Analyst-zone doc — drifted on disk.
    const analyst = await seedDoc(
      storage,
      "nodes/analyst-doc",
      "analyst v1\n",
      { zone: "client-acme", governance: "primary" },
    );
    await writeFile(
      join(root, "nodes", "analyst-doc.md"),
      analyst.replace("analyst v1", "analyst edit"),
      "utf-8",
    );

    const result = await runHygienistScan({
      storage,
      rbac: ingestOnly(["client-acme"]),
      actor: "user:analyst-7",
    });

    const leadership = result.entries.find(
      (e) => e.documentId === "nodes/leadership-doc",
    );
    const analystEntry = result.entries.find(
      (e) => e.documentId === "nodes/analyst-doc",
    );

    expect(leadership?.skippedReason).toBe("no-ingest-permission");
    expect(leadership?.staged).toBeUndefined();
    expect(analystEntry?.staged).toBeDefined();
    expect(result.permissionFiltered).toBe(1);
  });

  it("default-deny RBAC: scanner produces zero staged suggestions", async () => {
    const a = await seedDoc(storage, "nodes/x", "v1\n", {
      zone: "enterprise",
      governance: "standard",
    });
    await writeFile(
      join(root, "nodes", "x.md"),
      a.replace("v1", "v2"),
      "utf-8",
    );
    const result = await runHygienistScan({
      storage,
      rbac: DENY_ALL,
      actor: "user:nobody",
    });
    expect(result.stagedCount).toBe(0);
    expect(result.permissionFiltered).toBeGreaterThan(0);
  });

  it("idempotency: a second scan does not re-stage the same drift", async () => {
    const a = await seedDoc(storage, "nodes/playbook", "approved\n", {
      zone: "client-acme",
      governance: "primary",
    });
    await writeFile(
      join(root, "nodes", "playbook.md"),
      a.replace("approved", "user-edit"),
      "utf-8",
    );
    const first = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
    });
    expect(first.stagedCount).toBe(1);

    const second = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
    });
    expect(second.stagedCount).toBe(0);
    const entry = second.entries.find((e) => e.documentId === "nodes/playbook");
    expect(entry?.skippedReason).toBe("already-staged");
  });

  it("force re-stage when skipDocsWithPendingSuggestions=false", async () => {
    const a = await seedDoc(storage, "nodes/playbook", "approved\n", {
      zone: "client-acme",
      governance: "primary",
    });
    await writeFile(
      join(root, "nodes", "playbook.md"),
      a.replace("approved", "user-edit"),
      "utf-8",
    );
    await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
    });
    // Sleep 5ms to ensure suggestion ID timestamp differs.
    await new Promise((r) => setTimeout(r, 5));
    const second = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
      skipDocsWithPendingSuggestions: false,
    });
    expect(second.stagedCount).toBe(1);
  });

  it("uses classification manifest to resolve zone when frontmatter lacks it", async () => {
    const { raw } = buildDoc({
      title: "Implicit",
      body: "v1\n",
      version: 1,
    });
    await mkdir(join(root, "nodes", "client"), { recursive: true });
    await writeFile(join(root, "nodes", "client", "deal.md"), raw, "utf-8");
    const verDir = join(root, "nodes", "client", ".versions", "deal");
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
      join(root, "nodes", "client", "deal.md"),
      raw.replace("v1", "v2"),
      "utf-8",
    );

    const result = await runHygienistScan({
      storage,
      rbac: ingestOnly(["client-acme"]),
      actor: "user:rep-1",
      manifest: MANIFEST,
    });
    const entry = result.entries.find(
      (e) => e.documentId === "nodes/client/deal",
    );
    expect(entry?.staged?.zone).toBe("client-acme");
    expect(entry?.staged?.doc_tier).toBe("primary");
  });

  it("skips with reason 'unresolved-zone' when no zone derivable", async () => {
    const { raw } = buildDoc({
      title: "NoZone",
      body: "v1\n",
      version: 1,
    });
    await writeFile(join(root, "nodes", "no-zone.md"), raw, "utf-8");
    const verDir = join(root, "nodes", ".versions", "no-zone");
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
      join(root, "nodes", "no-zone.md"),
      raw.replace("v1", "v2"),
      "utf-8",
    );

    const result = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
      // No manifest, no defaultZone.
    });
    const entry = result.entries.find(
      (e) => e.documentId === "nodes/no-zone",
    );
    expect(entry?.skippedReason).toBe("unresolved-zone");
  });

  it("non-locking: scan does NOT mutate the live drifted file", async () => {
    const a = await seedDoc(storage, "nodes/race", "approved\n", {
      zone: "enterprise",
      governance: "standard",
    });
    const driftedBytes = a.replace("approved", "concurrent-edit");
    await writeFile(join(root, "nodes", "race.md"), driftedBytes, "utf-8");

    await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
    });

    const after = await readFile(join(root, "nodes", "race.md"), "utf-8");
    expect(after).toBe(driftedBytes);
  });

  it("does not throw on per-doc failure; bad doc isolated", async () => {
    const a = await seedDoc(storage, "nodes/good", "approved-good\n", {
      zone: "enterprise",
      governance: "standard",
    });
    // Bad doc with checksum + frontmatter zone but NO history.
    const { raw: badRaw } = buildDoc({
      title: "Bad",
      body: "approved-bad\n",
      zone: "enterprise",
      governance: "standard",
    });
    await writeFile(
      join(root, "nodes", "bad.md"),
      badRaw.replace("approved-bad", "drifted-bad"),
      "utf-8",
    );
    await writeFile(
      join(root, "nodes", "good.md"),
      a.replace("approved-good", "drifted-good"),
      "utf-8",
    );

    const result = await runHygienistScan({
      storage,
      rbac: ALLOW_ALL,
      actor: "system:scanner",
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
