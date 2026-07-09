/**
 * Integration test: frontmatter ACL enforced through the real engine read gate.
 *
 * Writes a document whose `metadata.access` block restricts it, then reads it
 * back through `NestStorage.readDocument` — the same path the MCP `read_document`
 * tool uses — with `makeAclGovernance` standing in for a per-query requester.
 * This proves the ACL survives a real YAML round-trip and that `requireRead`
 * honors the hook's verdict (throwing `UnauthorizedActionError` on deny).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NestStorage,
  allowAllGovernance,
  UnauthorizedActionError,
} from "@promptowl/contextnest-engine";
import { makeAclGovernance } from "../acl-governance.js";

const DOC = [
  "---",
  "title: Patient Chart",
  "type: document",
  "status: published",
  "metadata:",
  "  access:",
  "    visibility: private",
  "    readers:",
  "      - alice@clinic",
  "    roles:",
  "      - doctor",
  "---",
  "",
  "# Patient Chart",
  "",
  "Confidential contents.",
].join("\n");

describe("frontmatter ACL through the engine read gate", () => {
  let root: string;
  let storage: NestStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cn-acl-"));
    mkdirSync(join(root, ".context"), { recursive: true });
    writeFileSync(join(root, ".context", "config.yaml"), `version: 1\nname: "ACL Vault"\n`);
    mkdirSync(join(root, "nodes"), { recursive: true });
    writeFileSync(join(root, "nodes", "chart.md"), DOC);
    storage = new NestStorage(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("admits a reader listed by principal id", async () => {
    const gov = makeAclGovernance(allowAllGovernance, storage, "alice@clinic");
    const doc = await storage.readDocument("nodes/chart", { governance: gov, actor: "alice@clinic" });
    expect(doc.frontmatter.title).toBe("Patient Chart");
  });

  it("admits a reader whose role is listed", async () => {
    const gov = makeAclGovernance(allowAllGovernance, storage, "carol@clinic", "doctor");
    const doc = await storage.readDocument("nodes/chart", { governance: gov, actor: "carol@clinic" });
    expect(doc.body).toContain("Confidential");
  });

  it("denies an unauthorized principal/role", async () => {
    const gov = makeAclGovernance(allowAllGovernance, storage, "mallory@clinic", "janitor");
    await expect(
      storage.readDocument("nodes/chart", { governance: gov, actor: "mallory@clinic" }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
  });

  it("is unrestricted when no asker is supplied (legacy single-principal read)", async () => {
    // No ACL layer: base governance only, as the tools behave without `asker`.
    const doc = await storage.readDocument("nodes/chart", {
      governance: allowAllGovernance,
      actor: "local-mcp",
    });
    expect(doc.frontmatter.title).toBe("Patient Chart");
  });
});
