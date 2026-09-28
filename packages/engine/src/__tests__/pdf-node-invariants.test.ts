/**
 * Regression guard for the `pdf` node type (CU-wdqcq02pmg): the OTHER side of
 * the feature. Adding a type, a frontmatter block, a binary sidecar and a new
 * verification check must not move a single byte or hash for the documents a
 * vault already holds, nor loosen the `source:` / `skill:` rules, nor let a
 * `.pdf` file be mistaken for a node.
 *
 * Golden values were captured on the base branch BEFORE the feature landed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NestStorage } from "../storage.js";
import { serializeDocument, validateDocument, getChecksumContent } from "../parser.js";
import { computeContentHash, computeChainHash, sha256 } from "../integrity.js";
import { NODE_TYPES } from "../schemas.js";
import { publishDocument } from "../publish.js";
import type { ContextNode, Frontmatter } from "../types.js";
import { buildPdf } from "./fixtures/pdf-fixtures.js";

function plainNode(): ContextNode {
  const frontmatter: Frontmatter = {
    title: "Plain",
    type: "document",
    tags: ["#a"],
    status: "published",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return {
    id: "nodes/plain",
    filePath: "",
    rawContent: "",
    frontmatter,
    body: "\n# Plain\n\nBody text.\n",
  };
}

function node(frontmatter: Partial<Frontmatter> & { title: string }, id = "nodes/x"): ContextNode {
  return { id, filePath: "", rawContent: "", frontmatter: frontmatter as Frontmatter, body: "\nbody\n" };
}

const rulesOf = (n: ContextNode) => validateDocument(n).errors.map((e) => e.rule).sort();

describe("pdf node type — invariants for everything that is not a pdf", () => {
  it("keeps every existing node type", () => {
    for (const t of [
      "document", "snippet", "glossary", "persona", "prompt", "source",
      "tool", "reference", "skill", "agent", "artifact", "table",
    ]) {
      expect(NODE_TYPES).toContain(t);
    }
  });

  it("serializes a plain document to the same bytes and hashes as before", () => {
    const serialized = serializeDocument(plainNode());
    expect(serialized).toBe(
      [
        "---",
        "title: Plain",
        "type: document",
        "tags:",
        "  - '#a'",
        "status: published",
        "version: 1",
        "created_at: '2026-01-01T00:00:00.000Z'",
        "updated_at: '2026-01-01T00:00:00.000Z'",
        "---",
        "",
        "# Plain",
        "",
        "Body text.",
        "",
      ].join("\n"),
    );
    expect(sha256(serialized)).toBe(
      "sha256:b218afe53a96112c125751292c2be3980177ff5fbfc6d472500963ec66b4a24d",
    );
    const checksum = computeContentHash(getChecksumContent(serialized));
    expect(checksum).toBe("sha256:05084cd13c981b4b691a2b38f9b216142b68cd4c2929498a185bc5cb2f00a3a0");
    expect(
      computeChainHash(null, checksum, 1, "a@example.com", "2026-01-01T00:00:00.000Z"),
    ).toBe("sha256:83971c9d5e590edb3343677376dd582ea89940467e84ad64b79f71e4f724cace");
  });

  it("still validates a plain document with no errors", () => {
    expect(validateDocument(plainNode()).valid).toBe(true);
  });

  it("keeps the source: present-iff rules (9 and 17)", () => {
    expect(rulesOf(node({ title: "S", type: "source" }))).toEqual([9]);
    expect(
      rulesOf(node({ title: "D", type: "document", source: { transport: "mcp", tools: ["t"] } })),
    ).toEqual([17]);
    expect(
      validateDocument(node({ title: "S", type: "source", source: { transport: "mcp", tools: ["t"] } }))
        .valid,
    ).toBe(true);
  });

  it("keeps the skill: present-iff rules", () => {
    const missing = validateDocument(node({ title: "K", type: "skill" }));
    expect(missing.valid).toBe(false);
    expect(missing.errors.some((e) => e.field === "skill")).toBe(true);
    const stray = validateDocument(node({ title: "D", type: "document", skill: { trigger: "x" } }));
    expect(stray.valid).toBe(false);
    expect(stray.errors.some((e) => e.field === "skill")).toBe(true);
    expect(validateDocument(node({ title: "K", type: "skill", skill: { trigger: "x" } })).valid).toBe(true);
  });
});

describe("pdf node type — discovery and verification of plain vaults", () => {
  let dir: string;
  let storage: NestStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cn-pdf-invariants-"));
    storage = new NestStorage(dir);
    await mkdir(join(dir, "nodes", "sub"), { recursive: true });
    await storage.writeDocument("nodes/a", serializeDocument({ ...plainNode(), id: "nodes/a" }));
    await storage.writeDocument("nodes/sub/b", serializeDocument({ ...plainNode(), id: "nodes/sub/b" }));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never discovers a .pdf file as a node, and folder counts ignore it", async () => {
    const before = (await storage.discoverDocuments()).map((d) => d.id).sort();
    const foldersBefore = await storage.listFolders();
    await writeFile(join(dir, "nodes", "stray.pdf"), buildPdf([{ lines: ["x"] }]));
    await writeFile(join(dir, "nodes", "sub", "b.pdf"), buildPdf([{ lines: ["y"] }]));
    const after = (await storage.discoverDocuments()).map((d) => d.id).sort();
    expect(after).toEqual(before);
    expect(after).toEqual(["nodes/a", "nodes/sub/b"]);
    expect(await storage.listFolders()).toEqual(foldersBefore);
  });

  it("verifies a vault of plain published documents clean", async () => {
    await publishDocument(storage, "nodes/a", { editedBy: "t@example.com" });
    await publishDocument(storage, "nodes/sub/b", { editedBy: "t@example.com" });
    const report = await storage.verifyVaultIntegrity();
    expect(report).toEqual({ valid: true, errors: [] });
  });

  it("deleting a plain document leaves unrelated files alone", async () => {
    await writeFile(join(dir, "nodes", "a.pdf"), buildPdf([{ lines: ["z"] }]));
    await storage.deleteDocument("nodes/a");
    const { existsSync } = await import("node:fs");
    // Not a declared sidecar (nodes/a is a plain document), so not the engine's to remove.
    expect(existsSync(join(dir, "nodes", "a.pdf"))).toBe(true);
    expect(existsSync(join(dir, "nodes", "a.md"))).toBe(false);
  });
});
