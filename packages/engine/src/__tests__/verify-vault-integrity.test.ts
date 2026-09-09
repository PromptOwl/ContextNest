import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { NestStorage } from "../storage.js";
import { computeContentHash, computeChainHash } from "../integrity.js";
import { getChecksumContent } from "../parser.js";
import type { DocumentHistory } from "../types.js";

/**
 * Write a published v1 document on disk with a VALID keyframe + history,
 * mirroring the real VersionManager semantics (versioning.ts §46-66):
 *   - keyframe file `v1.md` holds the full serialized document
 *   - history `content_hash` = computeContentHash(full keyframe content)
 *   - canonical `.md` carries a body-only checksum (§1.5) so it does not drift
 *
 * Returns the on-disk keyframe path so a test can tamper it.
 */
async function seedPublishedDoc(
  storage: NestStorage,
  relPath: string,
  body: string,
): Promise<{ keyframePath: string }> {
  const editedBy = "czar:vp";
  const editedAt = "2026-04-19T12:00:00Z";

  // Canonical body-only checksum (per §1.5) so verifyVaultIntegrity's
  // body_drift check stays green and can't mask the keyframe assertion.
  const placeholder =
    `---\ntitle: ${relPath}\nversion: 1\nchecksum: 'sha256:${"0".repeat(64)}'\n---\n` + body;
  const bodyHash = computeContentHash(getChecksumContent(placeholder));
  const raw =
    `---\ntitle: ${relPath}\nversion: 1\nchecksum: '${bodyHash}'\n---\n` + body;

  // Keyframe content == full serialized doc; content_hash hashes the FULL file.
  const contentHash = computeContentHash(raw);
  const chainHash = computeChainHash(null, contentHash, 1, editedBy, editedAt);

  const docName = relPath.split("/").pop()!;
  const docDir = relPath.split("/").slice(0, -1).join("/");
  const filePath = join(storage.root, `${relPath}.md`);
  const verDir = join(storage.root, docDir, ".versions", docName);
  await mkdir(join(filePath, ".."), { recursive: true });
  await mkdir(verDir, { recursive: true });
  await writeFile(filePath, raw, "utf-8");

  const keyframePath = join(verDir, "v1.md");
  await writeFile(keyframePath, raw, "utf-8");

  const history: DocumentHistory = {
    keyframe_interval: 10,
    versions: [
      {
        version: 1,
        keyframe: true,
        edited_by: editedBy,
        edited_at: editedAt,
        content_hash: contentHash,
        chain_hash: chainHash,
      },
    ],
  };
  await writeFile(join(verDir, "history.yaml"), yaml.dump(history), "utf-8");

  return { keyframePath };
}

describe("verifyVaultIntegrity — version keyframe tamper detection", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ctxnest-vvi-"));
    await mkdir(join(root, "nodes"), { recursive: true });
    storage = new NestStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes on an untampered vault", async () => {
    await seedPublishedDoc(storage, "nodes/secret", "trusted body content\n");
    const report = await storage.verifyVaultIntegrity();
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("reports content_hash_mismatch when a version keyframe is tampered out of band", async () => {
    const { keyframePath } = await seedPublishedDoc(storage, "nodes/secret", "trusted body content\n");

    // Rewrite history bytes directly — canonical .md and history.yaml metadata
    // are left untouched, so only a keyframe re-hash can catch this.
    await appendFile(keyframePath, "\nMALICIOUS HISTORY REWRITE\n", "utf-8");

    const report = await storage.verifyVaultIntegrity();
    expect(report.valid).toBe(false);
    expect(report.errors.map((e) => e.type)).toContain("content_hash_mismatch");
  });
});
