import { describe, it, expect } from "vitest";
import { mkdtemp, cp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NestStorage,
  normalizeStatus,
  parseDocument,
  serializeDocument,
  publishDocument,
  isDraft,
  isPendingReview,
  isApproved,
  isPublished,
  isRejected,
  isRetrievable,
  isSuperseded,
  RejectedDocumentError,
  GraphQueryEngine,
  STATUSES,
  STATUS_ALIASES,
} from "../index.js";

const FIXTURES = join(__dirname, "../../../../fixtures/minimal-vault");

async function freshVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ctx-status-"));
  await cp(FIXTURES, dir, { recursive: true });
  return dir;
}

function makeNode(status: unknown) {
  const yamlStatus = typeof status === "string" ? `"${status}"` : String(status);
  const content = `---\ntitle: "Probe"\nstatus: ${yamlStatus}\n---\n\n# Probe\n`;
  return parseDocument("/tmp/probe.md", content, "probe");
}

describe("normalizeStatus", () => {
  it("passes canonical values through unchanged", () => {
    for (const s of STATUSES) {
      expect(normalizeStatus(s)).toBe(s);
    }
  });

  it("normalizes every alias to its canonical value", () => {
    for (const [alias, canonical] of Object.entries(STATUS_ALIASES)) {
      expect(normalizeStatus(alias)).toBe(canonical);
    }
  });

  it("is case-insensitive", () => {
    expect(normalizeStatus("CANCELLED")).toBe("rejected");
    expect(normalizeStatus("Superseded")).toBe("draft");
    expect(normalizeStatus("LIVE")).toBe("published");
  });

  it("trims whitespace", () => {
    expect(normalizeStatus("  published  ")).toBe("published");
  });

  it("falls back to draft for unknown values", () => {
    expect(normalizeStatus("pubished")).toBe("draft");
    expect(normalizeStatus("foo")).toBe("draft");
    expect(normalizeStatus("")).toBe("draft");
  });

  it("falls back to draft for non-strings", () => {
    expect(normalizeStatus(undefined)).toBe("draft");
    expect(normalizeStatus(null)).toBe("draft");
    expect(normalizeStatus(42)).toBe("draft");
    expect(normalizeStatus({ status: "published" })).toBe("draft");
  });
});

describe("parseDocument normalizes status", () => {
  it("converts superseded to draft", () => {
    const node = makeNode("superseded");
    expect(node.frontmatter.status).toBe("draft");
  });

  it("converts cancelled to rejected", () => {
    const node = makeNode("cancelled");
    expect(node.frontmatter.status).toBe("rejected");
  });

  it("converts unknown to draft", () => {
    const node = makeNode("garbage");
    expect(node.frontmatter.status).toBe("draft");
  });

  it("leaves canonical untouched", () => {
    expect(makeNode("draft").frontmatter.status).toBe("draft");
    expect(makeNode("approved").frontmatter.status).toBe("approved");
    expect(makeNode("published").frontmatter.status).toBe("published");
    expect(makeNode("rejected").frontmatter.status).toBe("rejected");
  });
});

describe("serializeDocument normalizes on write", () => {
  it("rewrites aliased status to canonical", () => {
    const node = makeNode("draft");
    node.frontmatter.status = "cancelled" as any;
    const serialized = serializeDocument(node);
    expect(serialized).toMatch(/status:\s*rejected/);
  });
});

describe("predicates", () => {
  it("each canonical status matches exactly one predicate", () => {
    expect(isDraft(makeNode("draft"))).toBe(true);
    expect(isPendingReview(makeNode("pending_review"))).toBe(true);
    expect(isApproved(makeNode("approved"))).toBe(true);
    expect(isPublished(makeNode("published"))).toBe(true);
    expect(isRejected(makeNode("rejected"))).toBe(true);
  });

  it("isRetrievable covers only draft + published", () => {
    expect(isRetrievable(makeNode("draft"))).toBe(true);
    expect(isRetrievable(makeNode("published"))).toBe(true);
    expect(isRetrievable(makeNode("pending_review"))).toBe(false);
    expect(isRetrievable(makeNode("approved"))).toBe(false);
    expect(isRetrievable(makeNode("rejected"))).toBe(false);
  });

  it("review aliases land on pending_review (not approved)", () => {
    expect(normalizeStatus("review")).toBe("pending_review");
    expect(normalizeStatus("in_review")).toBe("pending_review");
    expect(normalizeStatus("submitted")).toBe("pending_review");
    expect(normalizeStatus("awaiting-review")).toBe("pending_review");
    // approved aliases stay on approved
    expect(normalizeStatus("reviewed")).toBe("approved");
    expect(normalizeStatus("signed_off")).toBe("approved");
  });

  it("isSuperseded always returns false post-normalize", () => {
    expect(isSuperseded(makeNode("superseded"))).toBe(false);
    expect(isSuperseded(makeNode("rejected"))).toBe(false);
  });
});

describe("publishDocument guard", () => {
  it("throws RejectedDocumentError on rejected doc", async () => {
    const vault = await freshVault();
    const storage = new NestStorage(vault);
    const id = "nodes/legacy-soap-bridge";
    // Fixture already has status: rejected.
    await expect(publishDocument(storage, id, { editedBy: "test" })).rejects.toBeInstanceOf(
      RejectedDocumentError,
    );
  });

  it("succeeds on a doc that was raw 'superseded' on disk (now normalized to draft)", async () => {
    const vault = await freshVault();
    const filePath = join(vault, "nodes/manual-superseded.md");
    await writeFile(
      filePath,
      `---\ntitle: "Manual Superseded"\nstatus: superseded\nversion: 1\n---\n\n# Body\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    const result = await publishDocument(storage, "nodes/manual-superseded", {
      editedBy: "test",
    });
    expect(result.node.frontmatter.status).toBe("published");
    expect(result.node.frontmatter.version).toBeGreaterThanOrEqual(1);
  });
});

describe("discoverDocuments filter", () => {
  it("excludes rejected by default", async () => {
    const vault = await freshVault();
    const storage = new NestStorage(vault);
    const docs = await storage.discoverDocuments();
    expect(docs.find((d) => d.id === "nodes/legacy-soap-bridge")).toBeUndefined();
  });

  it("includes rejected with includeRetired", async () => {
    const vault = await freshVault();
    const storage = new NestStorage(vault);
    const docs = await storage.discoverDocuments({ includeRetired: true });
    expect(docs.find((d) => d.id === "nodes/legacy-soap-bridge")).toBeDefined();
  });

  it("back-compat: includeSuperseded works as alias for includeRetired", async () => {
    const vault = await freshVault();
    const storage = new NestStorage(vault);
    const docs = await storage.discoverDocuments({ includeSuperseded: true });
    expect(docs.find((d) => d.id === "nodes/legacy-soap-bridge")).toBeDefined();
  });
});

describe("GraphQueryEngine retrieval", () => {
  it("excludes pending_review + approved + rejected even with includeDrafts", async () => {
    const vault = await freshVault();
    // Plant a pending_review doc.
    await writeFile(
      join(vault, "nodes/in-review.md"),
      `---\ntitle: "In Review"\ntype: document\nstatus: pending_review\n---\n\nBody\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    await storage.regenerateIndex();
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("type:document", { includeDrafts: true, full: true });
    const ids = new Set(result.documents.map((d) => d.id));
    expect(ids.has("nodes/legacy-soap-bridge")).toBe(false); // rejected
    expect(ids.has("nodes/schema-migration")).toBe(false); // approved
    expect(ids.has("nodes/in-review")).toBe(false); // pending_review
  });
});

describe("ctx index canonicalization (via storage round-trip)", () => {
  it("rewrites aliased status to canonical on serialize", async () => {
    const vault = await freshVault();
    const filePath = join(vault, "nodes/test-canon.md");
    await writeFile(
      filePath,
      `---\ntitle: "Canon"\nstatus: cancelled\n---\n\nBody\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    const doc = await storage.readDocument("nodes/test-canon");
    await storage.writeDocument("nodes/test-canon", serializeDocument(doc));
    const after = await readFile(filePath, "utf-8");
    expect(after).toMatch(/status:\s*rejected/);
    expect(after).not.toMatch(/status:\s*cancelled/);
  });
});

describe("GraphQueryEngine default mode (no includeDrafts)", () => {
  it("returns only published docs", async () => {
    const vault = await freshVault();
    await writeFile(
      join(vault, "nodes/in-review-default.md"),
      `---\ntitle: "In Review"\ntype: document\nstatus: pending_review\n---\n\nBody\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    await storage.regenerateIndex();
    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("type:document", { full: true });
    const ids = new Set(result.documents.map((d) => d.id));
    expect(ids.has("nodes/api-design")).toBe(true); // published fixture
    expect(ids.has("nodes/architecture-overview")).toBe(true); // published fixture
    expect(ids.has("nodes/onboarding-guide")).toBe(false); // draft fixture
    expect(ids.has("nodes/in-review-default")).toBe(false); // pending_review
    expect(ids.has("nodes/schema-migration")).toBe(false); // approved
    expect(ids.has("nodes/legacy-soap-bridge")).toBe(false); // rejected
  });
});

describe("context.yaml content filter", () => {
  it("excludes pending_review, approved, and rejected after regenerateIndex", async () => {
    const vault = await freshVault();
    await writeFile(
      join(vault, "nodes/in-review-yaml.md"),
      `---\ntitle: "In Review YAML"\ntype: document\nstatus: pending_review\n---\n\nBody\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    await storage.regenerateIndex();
    const yaml = await storage.readContextYaml();
    expect(yaml).not.toBeNull();
    const ids = new Set(yaml!.documents.map((d) => d.id));
    expect(ids.has("nodes/api-design")).toBe(true);
    expect(ids.has("nodes/schema-migration")).toBe(false); // approved
    expect(ids.has("nodes/legacy-soap-bridge")).toBe(false); // rejected
    expect(ids.has("nodes/in-review-yaml")).toBe(false); // pending_review
  });
});

describe("INDEX.md content", () => {
  it("includes all five canonical statuses in the per-folder index", async () => {
    const vault = await freshVault();
    await writeFile(
      join(vault, "nodes/in-review-index.md"),
      `---\ntitle: "In Review Index"\ntype: document\nstatus: pending_review\n---\n\nBody\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    await storage.regenerateIndex();
    const indexContent = await readFile(join(vault, "nodes/INDEX.md"), "utf-8");
    // Published fixture
    expect(indexContent).toMatch(/api-design/);
    expect(indexContent).toMatch(/published/);
    // Approved fixture (schema-migration)
    expect(indexContent).toMatch(/schema-migration/);
    expect(indexContent).toMatch(/approved/);
    // Rejected fixture (legacy-soap-bridge)
    expect(indexContent).toMatch(/legacy-soap-bridge/);
    expect(indexContent).toMatch(/rejected/);
    // Pending_review planted above
    expect(indexContent).toMatch(/in-review-index/);
    expect(indexContent).toMatch(/pending_review/);
    // Draft fixture (onboarding-guide)
    expect(indexContent).toMatch(/onboarding-guide/);
    expect(indexContent).toMatch(/draft/);
  });
});

describe("selector status:X alias normalization", () => {
  it("status:cancelled matches rejected docs (full mode)", async () => {
    const vault = await freshVault();
    const storage = new NestStorage(vault);
    await storage.regenerateIndex();
    const engine = new GraphQueryEngine(storage);
    // includeDrafts so the fullQuery isRetrievable gate doesn't filter
    // rejected before reaching the assertion — we want to confirm the
    // SELECTOR matched. Use storage.discoverDocuments path instead for a
    // cleaner check.
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const { parseSelector, evaluate, Resolver } = await import("../index.js");
    const resolver = new Resolver({ documents: docs });
    const ast = parseSelector("status:cancelled");
    const result = await evaluate(ast, { resolver });
    const ids = new Set(result.map((d) => d.id));
    expect(ids.has("nodes/legacy-soap-bridge")).toBe(true); // rejected matches via alias
    expect(ids.has("nodes/api-design")).toBe(false); // published does not
  });

  it("status:submitted matches pending_review docs (full mode)", async () => {
    const vault = await freshVault();
    await writeFile(
      join(vault, "nodes/sub-doc.md"),
      `---\ntitle: "Submitted"\ntype: document\nstatus: pending_review\n---\n\nBody\n`,
      "utf-8",
    );
    const storage = new NestStorage(vault);
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const { parseSelector, evaluate, Resolver } = await import("../index.js");
    const resolver = new Resolver({ documents: docs });
    const ast = parseSelector("status:submitted");
    const result = await evaluate(ast, { resolver });
    const ids = new Set(result.map((d) => d.id));
    expect(ids.has("nodes/sub-doc")).toBe(true);
  });

  it("index-evaluator: status:cancelled matches rejected docs in context.yaml", async () => {
    const vault = await freshVault();
    const storage = new NestStorage(vault);
    // Force a context.yaml that includes rejected so the index-evaluator
    // path has something to match against.
    const allDocs = await storage.discoverDocuments({ includeRetired: true });
    const { generateContextYaml, parseSelector, evaluateFromIndex } = await import(
      "../index.js"
    );
    const config = await storage.readConfig();
    const yaml = generateContextYaml(allDocs, config, null);
    const ast = parseSelector("status:cancelled");
    const ids = await evaluateFromIndex(ast, yaml.documents);
    expect(ids.has("nodes/legacy-soap-bridge")).toBe(true);
  });
});
