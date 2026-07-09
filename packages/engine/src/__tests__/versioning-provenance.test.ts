/**
 * CRITICAL compatibility suite: provenance `origin` on version entries must
 * never invalidate the SHA-256 hash chain (§6/§8).
 *
 * `computeChainHash` covers prev:content_hash:version:edited_by:edited_at
 * only — `origin` is stored-but-unhashed. Chains created before this feature
 * (no origin), after it (origin on every entry), and mixed must all verify.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { VersionManager } from "../versioning.js";
import { publishDocument } from "../publish.js";
import { verifyDocumentChain } from "../integrity.js";
import { serializeDocument } from "../parser.js";
import { documentHistorySchema } from "../schemas.js";
import type { ContextNode, Frontmatter } from "../types.js";

let vaultPath: string;
let storage: NestStorage;

function makeNode(id: string, title: string, version: number): ContextNode {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "published",
    version,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  return {
    id,
    filePath: "",
    frontmatter,
    body: `\n# ${title} v${version}\n`,
    rawContent: "",
  };
}

async function verifyChain(docId: string) {
  const history = await storage.readHistory(docId);
  expect(history).not.toBeNull();
  const keyframes = new Map<number, string>();
  for (const entry of history!.versions) {
    if (entry.keyframe) {
      const kf = await storage.readKeyframe(docId, entry.version);
      if (kf !== null) keyframes.set(entry.version, kf);
    }
  }
  return verifyDocumentChain(docId, history!, (v) => keyframes.get(v) ?? null);
}

beforeEach(async () => {
  vaultPath = await mkdtemp(join(tmpdir(), "contextnest-ver-prov-"));
  storage = new NestStorage(vaultPath);
  await storage.init("Versioning Provenance Vault");
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("VersionManager.createVersion — origin", () => {
  it("persists origin on the entry and round-trips through history.yaml + schema", async () => {
    const node = makeNode("nodes/doc", "Doc", 1);
    await storage.writeDocument("nodes/doc", serializeDocument(node));

    const vm = new VersionManager(storage);
    const entry = await vm.createVersion(node, "editor@acme.com", {
      origin: { client: "mcp", tool: "update_document", agent: "claude" },
    });
    expect(entry.origin).toEqual({
      client: "mcp",
      tool: "update_document",
      agent: "claude",
    });

    const history = await storage.readHistory("nodes/doc");
    expect(history!.versions[0].origin?.client).toBe("mcp");

    // Round-trips through the zod schema (schema knows the field).
    const parsed = documentHistorySchema.parse(history);
    expect(parsed.versions[0].origin?.tool).toBe("update_document");
  });

  it("entries without origin still work (field is optional)", async () => {
    const node = makeNode("nodes/plain", "Plain", 1);
    await storage.writeDocument("nodes/plain", serializeDocument(node));
    const vm = new VersionManager(storage);
    const entry = await vm.createVersion(node, "editor@acme.com");
    expect(entry.origin).toBeUndefined();
  });
});

describe("hash chain integrity with origin (the critical invariant)", () => {
  it("a chain whose entries ALL carry origin verifies", async () => {
    const vm = new VersionManager(storage);
    for (let v = 1; v <= 3; v++) {
      const node = makeNode("nodes/doc", "Doc", v);
      await storage.writeDocument("nodes/doc", serializeDocument(node));
      await vm.createVersion(node, "editor@acme.com", {
        origin: { client: "cli", tool: "publish", session_id: `s${v}` },
      });
    }
    const report = await verifyChain("nodes/doc");
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("a MIXED chain (pre-feature entries without origin, new entries with) verifies", async () => {
    const vm = new VersionManager(storage);
    // v1-v2: legacy entries, no origin
    for (let v = 1; v <= 2; v++) {
      const node = makeNode("nodes/mixed", "Mixed", v);
      await storage.writeDocument("nodes/mixed", serializeDocument(node));
      await vm.createVersion(node, "legacy@acme.com");
    }
    // v3: new entry with origin
    const node = makeNode("nodes/mixed", "Mixed", 3);
    await storage.writeDocument("nodes/mixed", serializeDocument(node));
    await vm.createVersion(node, "editor@acme.com", {
      origin: { client: "mcp", tool: "publish_document" },
    });

    const report = await verifyChain("nodes/mixed");
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it("publish flow with origin produces a verifiable chain", async () => {
    const draft = makeNode("nodes/pub", "Pub", 1);
    draft.frontmatter.status = "draft";
    await storage.writeDocument("nodes/pub", serializeDocument(draft));

    await publishDocument(storage, "nodes/pub", {
      editedBy: "editor@acme.com",
      origin: { client: "cli", tool: "publish" },
    });
    // Second publish, no origin — mixed within the same chain.
    await publishDocument(storage, "nodes/pub", { editedBy: "editor@acme.com" });

    const report = await verifyChain("nodes/pub");
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });
});
