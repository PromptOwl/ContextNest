import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  NestStorage,
  UNSTAGED_DRIFT_SENTINEL,
} from "../storage.js";
import { computeContentHash, computeChainHash } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import type { DocumentHistory } from "../types.js";

/**
 * Build a markdown document with a correct checksum embedded for `body`.
 * Lives outside the describe to keep each test self-contained.
 */
function buildDocument(opts: {
  title: string;
  body: string;
  version?: number;
  zone?: string;
  governance?: "primary" | "standard";
}): { raw: string; bodyHash: string } {
  const versionLine = opts.version ? `version: ${opts.version}\n` : "";
  const zoneLine = opts.zone ? `zone: ${opts.zone}\n` : "";
  const govLine = opts.governance ? `governance: ${opts.governance}\n` : "";

  // Two-pass: first build with placeholder, compute hash, then rebuild.
  const placeholder =
    "---\n" +
    `title: ${opts.title}\n` +
    versionLine +
    zoneLine +
    govLine +
    `checksum: 'sha256:${"0".repeat(64)}'\n` +
    "---\n" +
    opts.body;
  const bodyHash = computeContentHash(getChecksumContent(placeholder));
  const raw =
    "---\n" +
    `title: ${opts.title}\n` +
    versionLine +
    zoneLine +
    govLine +
    `checksum: '${bodyHash}'\n` +
    "---\n" +
    opts.body;
  return { raw, bodyHash };
}

describe("NestStorage.readDocument — drift detection (Story 3.1, Hootie §4.2)", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-drift-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("default options: reads live bytes verbatim (backward compat)", async () => {
    // Deliberate mismatch — stored checksum is wrong on purpose.
    const wrongChecksumDoc =
      "---\n" +
      "title: Live\n" +
      `checksum: 'sha256:${"a".repeat(64)}'\n` +
      "---\n" +
      "drifted body\n";
    await writeFile(
      join(root, "nodes", "doc.md"),
      wrongChecksumDoc,
      "utf-8",
    );

    const node = await storage.readDocument("nodes/doc");
    expect(node.body).toContain("drifted body");
    expect(node.pendingChange).toBeUndefined();
  });

  it("verifyChecksum + matching hash: returns live node with no pendingChange", async () => {
    const { raw } = buildDocument({
      title: "Clean Doc",
      body: "untouched body\n",
    });
    await writeFile(join(root, "nodes", "clean.md"), raw, "utf-8");

    const node = await storage.readDocument("nodes/clean", {
      verifyChecksum: true,
    });
    expect(node.pendingChange).toBeUndefined();
    expect(node.body).toContain("untouched body");
  });

  it("verifyChecksum + drift + keyframe: returns APPROVED content, not live bytes (§4.2)", async () => {
    // Approved canonical body (v1).
    const approvedBody = "Pricing tier A is $99/mo.\n";
    const { raw: approvedRaw, bodyHash: approvedHash } = buildDocument({
      title: "Sales Playbook",
      body: approvedBody,
      version: 1,
      zone: "client-acme",
      governance: "primary",
    });

    // Write keyframe v1 and history pointing at it.
    await mkdir(join(root, "nodes", ".versions", "playbook"), {
      recursive: true,
    });
    await writeFile(
      join(root, "nodes", ".versions", "playbook", "v1.md"),
      approvedRaw,
      "utf-8",
    );
    const chain = computeChainHash(
      null,
      approvedHash,
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
          content_hash: approvedHash,
          chain_hash: chain,
        },
      ],
    };
    await writeFile(
      join(root, "nodes", ".versions", "playbook", "history.yaml"),
      yaml.dump(history),
      "utf-8",
    );

    // Now simulate an out-of-band edit: write the live file with a NEW body
    // but keep the old stored checksum (this is exactly the user's bug).
    const driftedLive =
      "---\n" +
      "title: Sales Playbook\n" +
      "version: 1\n" +
      "zone: client-acme\n" +
      "governance: primary\n" +
      `checksum: '${approvedHash}'\n` +
      "---\n" +
      "Pricing tier A is $129/mo.\n"; // out-of-band edit
    await writeFile(join(root, "nodes", "playbook.md"), driftedLive, "utf-8");

    const node = await storage.readDocument("nodes/playbook", {
      verifyChecksum: true,
    });

    // §4.2: returned body is the APPROVED state.
    expect(node.body).toContain("$99/mo.");
    expect(node.body).not.toContain("$129/mo.");

    // pendingChange flagged with drift evidence.
    expect(node.pendingChange).toBeDefined();
    expect(node.pendingChange?.suggestion_id).toBe(UNSTAGED_DRIFT_SENTINEL);
    expect(node.pendingChange?.source).toBe("out-of-band-edit");
    expect(node.pendingChange?.proposed_hash).not.toBe(approvedHash);
    expect(node.pendingChange?.detected_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("verifyChecksum + drift + no keyframe: returns live bytes with pendingChange (legacy fallback)", async () => {
    // Stored checksum is wrong; no version history exists.
    const liveRaw =
      "---\n" +
      "title: Legacy\n" +
      `checksum: 'sha256:${"a".repeat(64)}'\n` +
      "---\n" +
      "drifted legacy body\n";
    await writeFile(join(root, "nodes", "legacy.md"), liveRaw, "utf-8");

    const node = await storage.readDocument("nodes/legacy", {
      verifyChecksum: true,
    });

    // No keyframe → live bytes returned but flagged.
    expect(node.body).toContain("drifted legacy body");
    expect(node.pendingChange).toBeDefined();
    expect(node.pendingChange?.suggestion_id).toBe(UNSTAGED_DRIFT_SENTINEL);
    expect(node.pendingChange?.source).toBe("out-of-band-edit");
  });

  it("verifyChecksum + no stored checksum: not considered drifted", async () => {
    const noChecksum =
      "---\n" +
      "title: Unchecked\n" +
      "---\n" +
      "any body\n";
    await writeFile(join(root, "nodes", "unchecked.md"), noChecksum, "utf-8");

    const node = await storage.readDocument("nodes/unchecked", {
      verifyChecksum: true,
    });
    expect(node.pendingChange).toBeUndefined();
  });

  it("CRLF / BOM in the live file does not register as drift", async () => {
    const { raw } = buildDocument({
      title: "CRLF doc",
      body: "tolerant body\n",
    });
    // Write a CRLF + BOM version of the same content.
    const mangled = "﻿" + raw.replace(/\n/g, "\r\n");
    await writeFile(join(root, "nodes", "crlf.md"), mangled, "utf-8");

    const node = await storage.readDocument("nodes/crlf", {
      verifyChecksum: true,
    });
    expect(node.pendingChange).toBeUndefined();
  });

  it("throws DocumentNotFoundError when the live file is missing", async () => {
    await expect(
      storage.readDocument("nodes/missing", { verifyChecksum: true }),
    ).rejects.toThrow();
  });
});

describe("NestStorage.detectDocumentDrift — read-only probe", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-probe-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns drifted=true when stored checksum disagrees with body", async () => {
    const liveRaw =
      "---\n" +
      "title: D\n" +
      `checksum: 'sha256:${"a".repeat(64)}'\n` +
      "---\n" +
      "different body\n";
    await writeFile(join(root, "nodes", "doc.md"), liveRaw, "utf-8");

    const report = await storage.detectDocumentDrift("nodes/doc");
    expect(report).not.toBeNull();
    expect(report?.drifted).toBe(true);
  });

  it("returns null when the document does not exist", async () => {
    const report = await storage.detectDocumentDrift("nodes/missing");
    expect(report).toBeNull();
  });

  it("returns drifted=false when stored checksum matches", async () => {
    const { raw } = buildDocument({ title: "OK", body: "stable\n" });
    await writeFile(join(root, "nodes", "ok.md"), raw, "utf-8");
    const report = await storage.detectDocumentDrift("nodes/ok");
    expect(report?.drifted).toBe(false);
  });
});

describe("NestStorage.readLatestApprovedKeyframe", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-kf-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns null when no history exists", async () => {
    const result = await storage.readLatestApprovedKeyframe("nodes/none");
    expect(result).toBeNull();
  });

  it("returns the most recent keyframe content when present", async () => {
    await mkdir(join(root, "nodes", ".versions", "doc"), { recursive: true });
    await writeFile(
      join(root, "nodes", ".versions", "doc", "v1.md"),
      "v1 content\n",
      "utf-8",
    );
    await writeFile(
      join(root, "nodes", ".versions", "doc", "v2.md"),
      "v2 content\n",
      "utf-8",
    );
    const hash1 = computeContentHash("v1 content\n");
    const hash2 = computeContentHash("v2 content\n");
    const chain1 = computeChainHash(null, hash1, 1, "czar:a", "2026-01-01T00:00:00Z");
    const chain2 = computeChainHash(chain1, hash2, 2, "czar:a", "2026-02-01T00:00:00Z");
    const history: DocumentHistory = {
      keyframe_interval: 10,
      versions: [
        {
          version: 1,
          keyframe: true,
          edited_by: "czar:a",
          edited_at: "2026-01-01T00:00:00Z",
          content_hash: hash1,
          chain_hash: chain1,
        },
        {
          version: 2,
          keyframe: true,
          edited_by: "czar:a",
          edited_at: "2026-02-01T00:00:00Z",
          content_hash: hash2,
          chain_hash: chain2,
        },
      ],
    };
    await writeFile(
      join(root, "nodes", ".versions", "doc", "history.yaml"),
      yaml.dump(history),
      "utf-8",
    );

    const result = await storage.readLatestApprovedKeyframe("nodes/doc");
    expect(result).not.toBeNull();
    expect(result?.version).toBe(2);
    expect(result?.content).toContain("v2 content");
  });

  it("skips non-keyframe entries and falls back to the most recent keyframe", async () => {
    await mkdir(join(root, "nodes", ".versions", "doc"), { recursive: true });
    await writeFile(
      join(root, "nodes", ".versions", "doc", "v1.md"),
      "v1 keyframe\n",
      "utf-8",
    );
    const hash1 = computeContentHash("v1 keyframe\n");
    const chain1 = computeChainHash(null, hash1, 1, "czar:a", "2026-01-01T00:00:00Z");
    // v2 is a diff entry (no keyframe file written).
    const diffStr = "@@ diff @@";
    const hash2 = computeContentHash(diffStr);
    const chain2 = computeChainHash(chain1, hash2, 2, "czar:a", "2026-02-01T00:00:00Z");
    const history: DocumentHistory = {
      keyframe_interval: 10,
      versions: [
        {
          version: 1,
          keyframe: true,
          edited_by: "czar:a",
          edited_at: "2026-01-01T00:00:00Z",
          content_hash: hash1,
          chain_hash: chain1,
        },
        {
          version: 2,
          diff: diffStr,
          edited_by: "czar:a",
          edited_at: "2026-02-01T00:00:00Z",
          content_hash: hash2,
          chain_hash: chain2,
        },
      ],
    };
    await writeFile(
      join(root, "nodes", ".versions", "doc", "history.yaml"),
      yaml.dump(history),
      "utf-8",
    );

    const result = await storage.readLatestApprovedKeyframe("nodes/doc");
    expect(result?.version).toBe(1);
    expect(result?.content).toContain("v1 keyframe");
  });
});
