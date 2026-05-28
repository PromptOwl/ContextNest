import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import {
  NestStorage,
  parseDocument,
  validateDocument,
  serializeDocument,
  parseUri,
  canonicalizeUri,
  Resolver,
  tokenize,
  parseSelector,
  evaluate,
  PackLoader,
  sha256,
  normalizeForHash,
  computeContentHash,
  computeChainHash,
  computeCheckpointHash,
  canonicalJson,
  verifyDocumentChain,
  buildRelationships,
  buildBacklinks,
  extractContextLinks,
  extractTags,
  extractMentions,
  extractSection,
  topologicalSortSources,
  detectCycles,
  generateContextYaml,
  generateIndexMd,
  DocumentNotFoundError,
  publishDocument,
  VersionManager,
} from "../index.js";
import type { ContextNode } from "../index.js";

const FIXTURES = join(__dirname, "../../../../fixtures/minimal-vault");

// ─── Parser Tests ──────────────────────────────────────────────────────────────

describe("Parser", () => {
  it("parses a document with full frontmatter", () => {
    const content = `---
title: "Test Doc"
type: document
tags:
  - "#api"
  - engineering
status: published
version: 2
---

# Test Doc

Body content here.
`;
    const node = parseDocument("/test.md", content, "test");
    expect(node.frontmatter.title).toBe("Test Doc");
    expect(node.frontmatter.type).toBe("document");
    expect(node.frontmatter.tags).toEqual(["#api", "#engineering"]);
    expect(node.frontmatter.status).toBe("published");
    expect(node.frontmatter.version).toBe(2);
    expect(node.body).toContain("Body content here.");
  });

  it("validates a valid document", () => {
    const content = `---
title: "Valid Doc"
type: document
status: draft
---

# Valid Doc
`;
    const node = parseDocument("/valid.md", content, "valid");
    const result = validateDocument(node);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects missing title (rule 2)", () => {
    const content = `---
type: document
---

# No title
`;
    const node = parseDocument("/bad.md", content, "bad");
    const result = validateDocument(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.rule === 2)).toBe(true);
  });

  it("validates source nodes require source block (rule 9)", () => {
    const content = `---
title: "Bad Source"
type: source
---

# Bad Source
`;
    const node = parseDocument("/bad-source.md", content, "bad-source");
    const result = validateDocument(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.rule === 9)).toBe(true);
  });

  it("validates source block not allowed on non-source types (rule 17)", () => {
    const content = `---
title: "Bad Doc"
type: document
source:
  transport: mcp
  tools:
    - some_tool
---

# Bad Doc
`;
    const node = parseDocument("/bad-doc.md", content, "bad-doc");
    const result = validateDocument(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.rule === 17)).toBe(true);
  });

  it("validates skill nodes require skill block", () => {
    const content = `---
title: "Bad Skill"
type: skill
---

# Bad Skill
`;
    const node = parseDocument("/bad-skill.md", content, "bad-skill");
    const result = validateDocument(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Skill block is required"))).toBe(true);
  });

  it("validates skill block not allowed on non-skill types", () => {
    const content = `---
title: "Bad Doc"
type: document
skill:
  trigger: "when asked to do something"
---

# Bad Doc
`;
    const node = parseDocument("/bad-doc-skill.md", content, "bad-doc-skill");
    const result = validateDocument(node);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Skill block must not be present"))).toBe(true);
  });

  it("validates valid skill nodes pass", () => {
    const content = `---
title: "Good Skill"
type: skill
tags:
  - "#engineering"
status: draft
version: 1
skill:
  trigger: "when asked to review a PR"
  inputs:
    - name: pr_url
      type: string
      required: true
  tools_required:
    - gh_pr_view
  output_format: markdown
  guard_rails:
    - "Do not merge"
---

# Good Skill

## Steps

1. Review the PR
`;
    const node = parseDocument("/good-skill.md", content, "good-skill");
    const result = validateDocument(node);
    expect(result.valid).toBe(true);
  });

  it("roundtrips parse and serialize", () => {
    const content = `---
title: "Roundtrip Test"
type: document
tags:
  - "#test"
status: draft
version: 1
---

# Roundtrip Test

Content here.
`;
    const node = parseDocument("/rt.md", content, "rt");
    const serialized = serializeDocument(node);
    const reparsed = parseDocument("/rt.md", serialized, "rt");
    expect(reparsed.frontmatter.title).toBe("Roundtrip Test");
    expect(reparsed.body).toContain("Content here.");
  });
});

// ─── URI Tests ─────────────────────────────────────────────────────────────────

describe("URI", () => {
  it("parses a simple document URI", () => {
    const uri = parseUri("contextnest://nodes/api-design");
    expect(uri.path).toBe("nodes/api-design");
    expect(uri.kind).toBe("document");
    expect(uri.checkpoint).toBeUndefined();
    expect(uri.anchor).toBeUndefined();
  });

  it("parses URI with anchor", () => {
    const uri = parseUri("contextnest://nodes/api-design#error-handling");
    expect(uri.path).toBe("nodes/api-design");
    expect(uri.anchor).toBe("error-handling");
  });

  it("parses URI with checkpoint pin", () => {
    const uri = parseUri("contextnest://nodes/api-design@7");
    expect(uri.path).toBe("nodes/api-design");
    expect(uri.checkpoint).toBe(7);
  });

  it("parses URI with both pin and anchor", () => {
    const uri = parseUri("contextnest://nodes/api-design@7#error-handling");
    expect(uri.path).toBe("nodes/api-design");
    expect(uri.checkpoint).toBe(7);
    expect(uri.anchor).toBe("error-handling");
  });

  it("parses tag URI", () => {
    const uri = parseUri("contextnest://tag/engineering");
    expect(uri.kind).toBe("tag");
    expect(uri.path).toBe("tag/engineering");
  });

  it("parses folder URI", () => {
    const uri = parseUri("contextnest://nodes/");
    expect(uri.kind).toBe("folder");
    expect(uri.path).toBe("nodes");
  });

  it("parses search URI", () => {
    const uri = parseUri("contextnest://search/rate+limiting");
    expect(uri.kind).toBe("search");
  });

  it("rejects @0", () => {
    expect(() => parseUri("contextnest://nodes/api@0")).toThrow("@0 is reserved");
  });

  it("rejects leading zeros in pin", () => {
    expect(() => parseUri("contextnest://nodes/api@07")).toThrow("leading zeros");
  });

  it("rejects consecutive slashes", () => {
    expect(() => parseUri("contextnest://nodes//api")).toThrow("Consecutive slashes");
  });

  it("rejects empty anchor", () => {
    expect(() => parseUri("contextnest://nodes/api#")).toThrow("Empty anchor");
  });

  it("resolves dot segments", () => {
    const uri = parseUri("contextnest://nodes/../sources/config");
    expect(uri.path).toBe("sources/config");
  });

  it("rejects path escaping root via ..", () => {
    expect(() => parseUri("contextnest://../../etc/passwd")).toThrow("escapes nest root");
  });

  it("canonicalizes URI", () => {
    const uri = parseUri("contextnest://nodes/api-design@7#error-handling");
    expect(canonicalizeUri(uri)).toBe("contextnest://nodes/api-design@7#error-handling");
  });
});

// ─── Selector Grammar Tests ───────────────────────────────────────────────────

describe("Selector Lexer", () => {
  it("tokenizes a tag", () => {
    const tokens = tokenize("#engineering");
    expect(tokens[0].type).toBe("TAG");
    expect(tokens[0].value).toBe("engineering");
  });

  it("tokenizes tag:#X as a TAG (spec-documented alias)", () => {
    const tokens = tokenize("tag:#engineering");
    expect(tokens[0].type).toBe("TAG");
    expect(tokens[0].value).toBe("engineering");
  });

  it("tokenizes tag:X (no leading hash) as a TAG", () => {
    const tokens = tokenize("tag:engineering");
    expect(tokens[0].type).toBe("TAG");
    expect(tokens[0].value).toBe("engineering");
  });

  it("rejects tag: with no value", () => {
    expect(() => tokenize("tag:")).toThrow("Invalid tag filter");
  });

  it("tokenizes type filter", () => {
    const tokens = tokenize("type:document");
    expect(tokens[0].type).toBe("TYPE_FILTER");
    expect(tokens[0].value).toBe("document");
  });

  it("tokenizes operators", () => {
    const tokens = tokenize("#a + #b | #c - #d");
    const types = tokens.map((t) => t.type);
    expect(types).toEqual(["TAG", "AND", "TAG", "OR", "TAG", "NOT", "TAG", "EOF"]);
  });

  it("tokenizes pack reference", () => {
    const tokens = tokenize("pack:onboarding.basics");
    expect(tokens[0].type).toBe("PACK");
    expect(tokens[0].value).toBe("onboarding.basics");
  });

  it("tokenizes transport and server filters", () => {
    const tokens = tokenize("transport:mcp server:jira");
    expect(tokens[0].type).toBe("TRANSPORT_FILTER");
    expect(tokens[1].type).toBe("SERVER_FILTER");
  });
});

describe("Selector Parser", () => {
  it("parses a simple tag", () => {
    const ast = parseSelector("#api");
    expect(ast.type).toBe("tag");
  });

  it("parses AND with +", () => {
    const ast = parseSelector("#api + type:document");
    expect(ast.type).toBe("and");
  });

  it("parses implicit AND", () => {
    const ast = parseSelector("#api type:document");
    expect(ast.type).toBe("and");
  });

  it("parses OR", () => {
    const ast = parseSelector("#api | #guide");
    expect(ast.type).toBe("or");
  });

  it("parses NOT", () => {
    const ast = parseSelector("#api - #deprecated");
    expect(ast.type).toBe("not");
  });

  it("respects precedence: AND binds tighter than OR", () => {
    const ast = parseSelector("#a + #b | #c");
    // Should be: (#a AND #b) OR #c
    expect(ast.type).toBe("or");
    if (ast.type === "or") {
      expect(ast.left.type).toBe("and");
    }
  });

  it("respects grouping", () => {
    const ast = parseSelector("(#a | #b) + #c");
    expect(ast.type).toBe("and");
    if (ast.type === "and") {
      expect(ast.left.type).toBe("or");
    }
  });
});

// ─── Inline Extraction Tests ──────────────────────────────────────────────────

describe("Inline Extraction", () => {
  it("extracts contextnest:// links from markdown", () => {
    const body = `See [API Design](contextnest://nodes/api-design) and [Arch](contextnest://nodes/architecture-overview).`;
    const links = extractContextLinks(body);
    expect(links).toHaveLength(2);
    expect(links[0]).toBe("contextnest://nodes/api-design");
    expect(links[1]).toBe("contextnest://nodes/architecture-overview");
  });

  it("extracts tags from body", () => {
    const body = "This relates to #engineering and #api topics.";
    const tags = extractTags(body);
    expect(tags).toContain("#engineering");
    expect(tags).toContain("#api");
  });

  it("extracts mentions", () => {
    const body = "Maintained by @jane.smith with @team:engineering.";
    const mentions = extractMentions(body);
    expect(mentions).toContain("@jane.smith");
    expect(mentions).toContain("@team:engineering");
  });

  it("extracts section by anchor", () => {
    const body = `# Title

Intro paragraph.

## Error Handling

Error handling content here.

## Rate Limiting

Rate limiting content.
`;
    const section = extractSection(body, "error-handling");
    expect(section).not.toBeNull();
    expect(section).toContain("Error handling content here.");
    expect(section).not.toContain("Rate limiting content.");
  });
});

// ─── Integrity Tests ──────────────────────────────────────────────────────────

describe("Integrity", () => {
  it("computes sha256 correctly", () => {
    const hash = sha256("hello");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("computes content_hash", () => {
    const hash = computeContentHash("test content");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("normalizeForHash strips BOM and normalizes line endings", () => {
    expect(normalizeForHash("\uFEFFhello")).toBe("hello");
    expect(normalizeForHash("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeForHash("a\rb")).toBe("a\nb");
    expect(normalizeForHash("\uFEFFa\r\nb\rc")).toBe("a\nb\nc");
  });

  it("content_hash is identical for LF and CRLF content", () => {
    const hashLF = computeContentHash("line1\nline2\n");
    const hashCRLF = computeContentHash("line1\r\nline2\r\n");
    expect(hashLF).toBe(hashCRLF);
  });

  it("content_hash is identical with and without BOM", () => {
    const hashNoBom = computeContentHash("hello world");
    const hashBom = computeContentHash("\uFEFFhello world");
    expect(hashNoBom).toBe(hashBom);
  });

  it("computes chain_hash with genesis sentinel", () => {
    const contentHash = computeContentHash("test");
    const chainHash = computeChainHash(null, contentHash, 1, "user@test.com", "2024-01-01T00:00:00Z");
    expect(chainHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("chain_hash changes when content changes", () => {
    const hash1 = computeContentHash("content v1");
    const hash2 = computeContentHash("content v2");
    const chain1 = computeChainHash(null, hash1, 1, "user@test.com", "2024-01-01T00:00:00Z");
    const chain2 = computeChainHash(null, hash2, 1, "user@test.com", "2024-01-01T00:00:00Z");
    expect(chain1).not.toBe(chain2);
  });

  it("chain_hash links to previous", () => {
    const ch1 = computeContentHash("v1");
    const chain1 = computeChainHash(null, ch1, 1, "user@test.com", "2024-01-01T00:00:00Z");
    const ch2 = computeContentHash("v2");
    const chain2 = computeChainHash(chain1, ch2, 2, "user@test.com", "2024-01-02T00:00:00Z");
    expect(chain2).not.toBe(chain1);
  });

  it("canonicalJson sorts keys", () => {
    const result = canonicalJson({ b: 2, a: 1, c: 3 });
    expect(result).toBe('{"a":1,"b":2,"c":3}');
  });

  it("computes checkpoint_hash", () => {
    const hash = computeCheckpointHash(
      null,
      1,
      "2024-01-01T00:00:00Z",
      "nodes/api-design",
      { "nodes/api-design": 1 },
      { "nodes/api-design": "sha256:abc123" },
    );
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ─── Source Graph Tests ───────────────────────────────────────────────────────

describe("Source Graph", () => {
  const makeSourceNode = (id: string, dependsOn: string[] = []): ContextNode => ({
    id,
    filePath: `/${id}.md`,
    frontmatter: {
      title: id,
      type: "source",
      source: {
        transport: "mcp",
        tools: ["test_tool"],
        depends_on: dependsOn.map((d) => `contextnest://${d}`),
      },
    },
    body: "",
    rawContent: "",
  });

  it("topologically sorts source nodes", () => {
    const nodes = [
      makeSourceNode("sources/c", ["sources/b"]),
      makeSourceNode("sources/a"),
      makeSourceNode("sources/b", ["sources/a"]),
    ];
    const sorted = topologicalSortSources(nodes);
    expect(sorted.indexOf("sources/a")).toBeLessThan(sorted.indexOf("sources/b"));
    expect(sorted.indexOf("sources/b")).toBeLessThan(sorted.indexOf("sources/c"));
  });

  it("detects cycles", () => {
    const nodes = [
      makeSourceNode("sources/a", ["sources/b"]),
      makeSourceNode("sources/b", ["sources/a"]),
    ];
    const cycle = detectCycles(nodes);
    expect(cycle).not.toBeNull();
  });

  it("returns null for acyclic graphs", () => {
    const nodes = [
      makeSourceNode("sources/a"),
      makeSourceNode("sources/b", ["sources/a"]),
    ];
    const cycle = detectCycles(nodes);
    expect(cycle).toBeNull();
  });
});

// ─── Storage Tests ────────────────────────────────────────────────────────────

describe("Storage", () => {
  const storage = new NestStorage(FIXTURES);

  it("detects structured layout", async () => {
    const layout = await storage.detectLayout();
    expect(layout).toBe("structured");
  });

  it("discovers documents", async () => {
    const docs = await storage.discoverDocuments();
    expect(docs.length).toBeGreaterThanOrEqual(4);
    const ids = docs.map((d) => d.id);
    expect(ids).toContain("nodes/api-design");
    expect(ids).toContain("nodes/architecture-overview");
    expect(ids).toContain("sources/active-project-config");
  });

  it("reads a single document", async () => {
    const doc = await storage.readDocument("nodes/api-design");
    expect(doc.frontmatter.title).toBe("API Design Guidelines");
    expect(doc.frontmatter.type).toBe("document");
    expect(doc.frontmatter.status).toBe("published");
  });

  it("reads config", async () => {
    const config = await storage.readConfig();
    expect(config).not.toBeNull();
    expect(config!.name).toBe("Test Vault");
    expect(config!.servers?.jira).toBeDefined();
  });

  it("reads packs", async () => {
    const packs = await storage.readPacks();
    expect(packs.length).toBeGreaterThanOrEqual(1);
    expect(packs[0].id).toBe("onboarding.basics");
  });

  it("reads CONTEXT.md", async () => {
    const content = await storage.readContextMd();
    expect(content).not.toBeNull();
    expect(content).toContain("Test Vault");
  });
});

// ─── Resolver Tests ───────────────────────────────────────────────────────────

describe("Resolver", () => {
  let docs: ContextNode[];
  let resolver: Resolver;

  beforeAll(async () => {
    const storage = new NestStorage(FIXTURES);
    docs = await storage.discoverDocuments();
    resolver = new Resolver({ documents: docs });
  });

  it("resolves a document by path", async () => {
    const uri = parseUri("contextnest://nodes/api-design");
    const results = await resolver.resolve(uri);
    expect(results).toHaveLength(1);
    expect(results[0].frontmatter.title).toBe("API Design Guidelines");
  });

  it("resolves tag URI", async () => {
    const uri = parseUri("contextnest://tag/engineering");
    const results = await resolver.resolve(uri);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("resolves folder URI", async () => {
    const uri = parseUri("contextnest://nodes/");
    const results = await resolver.resolve(uri);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns only published for floating resolution", async () => {
    const uri = parseUri("contextnest://nodes/onboarding-guide");
    const results = await resolver.resolve(uri);
    // onboarding-guide is draft, so should not appear
    expect(results).toHaveLength(0);
  });

  it("returns draft when includeDrafts is true", async () => {
    const uri = parseUri("contextnest://nodes/onboarding-guide");
    const results = await resolver.resolve(uri, { includeDrafts: true });
    expect(results).toHaveLength(1);
  });

  it("resolves section anchor", async () => {
    const uri = parseUri("contextnest://nodes/api-design#error-handling");
    const results = await resolver.resolve(uri);
    expect(results).toHaveLength(1);
    expect(results[0].body).toContain("HTTP status codes");
    expect(results[0].body).not.toContain("Rate Limiting");
  });
});

// ─── Selector Evaluator Tests ─────────────────────────────────────────────────

describe("Selector Evaluator", () => {
  let docs: ContextNode[];
  let resolver: Resolver;
  let packLoader: PackLoader;

  beforeAll(async () => {
    const storage = new NestStorage(FIXTURES);
    docs = await storage.discoverDocuments();
    const packs = await storage.readPacks();
    resolver = new Resolver({ documents: docs });
    packLoader = new PackLoader(packs);
  });

  it("evaluates tag selector", async () => {
    const ast = parseSelector("#engineering");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("evaluates type filter", async () => {
    const ast = parseSelector("type:source");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    for (const doc of results) {
      expect(doc.frontmatter.type).toBe("source");
    }
  });

  it("evaluates AND", async () => {
    const ast = parseSelector("#engineering + type:source");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    for (const doc of results) {
      expect(doc.frontmatter.type).toBe("source");
      expect(doc.frontmatter.tags?.some((t) => t === "#engineering" || t === "engineering")).toBe(true);
    }
  });

  it("evaluates OR", async () => {
    const ast = parseSelector("#api | #onboarding");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("evaluates NOT", async () => {
    const ast = parseSelector("#engineering - type:source");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    for (const doc of results) {
      expect(doc.frontmatter.type).not.toBe("source");
    }
  });

  it("evaluates transport filter", async () => {
    const ast = parseSelector("transport:mcp");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const doc of results) {
      expect(doc.frontmatter.source?.transport).toBe("mcp");
    }
  });

  it("evaluates server filter", async () => {
    const ast = parseSelector("server:jira");
    const results = await evaluate(ast, {
      resolver,
      packLoader: (id) => packLoader.get(id),
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const doc of results) {
      expect(doc.frontmatter.source?.server).toBe("jira");
    }
  });
});

// ─── Index Generation Tests ───────────────────────────────────────────────────

describe("Index Generation", () => {
  it("generates context.yaml with correct structure", async () => {
    const storage = new NestStorage(FIXTURES);
    const docs = await storage.discoverDocuments();
    const config = await storage.readConfig();
    const published = docs.filter((d) => d.frontmatter.status === "published");

    const yaml = generateContextYaml(published, config, null);

    expect(yaml.version).toBe(1);
    expect(yaml.documents.length).toBeGreaterThanOrEqual(3);

    // Tags should not have # prefix
    for (const doc of yaml.documents) {
      for (const tag of doc.tags) {
        expect(tag.startsWith("#")).toBe(false);
      }
    }

    // Source nodes should include source summary
    const sourceDoc = yaml.documents.find((d) => d.type === "source");
    expect(sourceDoc?.source).toBeDefined();
    expect(sourceDoc?.source?.transport).toBe("mcp");

    // External dependencies
    expect(yaml.external_dependencies.mcp_servers.length).toBeGreaterThanOrEqual(1);
    const jira = yaml.external_dependencies.mcp_servers.find((s) => s.name === "jira");
    expect(jira).toBeDefined();
    expect(jira!.used_by.length).toBeGreaterThanOrEqual(1);
  });

  it("generates INDEX.md with tables", () => {
    const docs: ContextNode[] = [
      {
        id: "nodes/api-design",
        filePath: "/test/nodes/api-design.md",
        frontmatter: {
          title: "API Design",
          type: "document",
          tags: ["#api"],
          status: "published",
        },
        body: "",
        rawContent: "",
      },
    ];

    const indexMd = generateIndexMd("nodes", "Nodes", docs);
    expect(indexMd).toContain("API Design");
    expect(indexMd).toContain("contextnest://nodes/api-design");
    expect(indexMd).toContain("Total documents: 1");
  });
});

// ─── Relationship Tests ───────────────────────────────────────────────────────

describe("Relationships", () => {
  it("builds reference edges from inline links", async () => {
    const storage = new NestStorage(FIXTURES);
    const docs = await storage.discoverDocuments();
    const edges = buildRelationships(docs);

    const refEdge = edges.find(
      (e) => e.from === "nodes/api-design" && e.type === "reference",
    );
    expect(refEdge).toBeDefined();
    expect(refEdge!.to).toBe("nodes/architecture-overview");
  });

  it("builds depends_on edges from source frontmatter", async () => {
    const storage = new NestStorage(FIXTURES);
    const docs = await storage.discoverDocuments();
    const edges = buildRelationships(docs);

    const depEdge = edges.find(
      (e) => e.from === "sources/sprint-tickets" && e.type === "depends_on",
    );
    expect(depEdge).toBeDefined();
    expect(depEdge!.to).toBe("sources/active-project-config");
  });

  it("builds backlinks map", async () => {
    const storage = new NestStorage(FIXTURES);
    const docs = await storage.discoverDocuments();
    const backlinks = buildBacklinks(docs);

    const archBacklinks = backlinks.get("nodes/architecture-overview");
    expect(archBacklinks).toBeDefined();
    expect(archBacklinks).toContain("nodes/api-design");
  });
});

// ─── Direct File Edit Detection Tests ────────────────────────────────────────

describe("Direct File Edit Detection", () => {
  let tempVault: string;
  let tempStorage: NestStorage;
  const docId = "nodes/edit-target";
  const originalContent = `---
title: "Edit Target"
type: document
status: draft
version: 1
---

# Edit Target

Original body.
`;

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    tempVault = await mkdtemp(join(tmpdir(), "contextnest-edit-test-"));
    tempStorage = new NestStorage(tempVault);
    await tempStorage.init("Edit Test Vault");

    // Write current doc + keyframe + history (simulate committed v1)
    await tempStorage.writeDocument(docId, originalContent);
    await tempStorage.writeKeyframe(docId, 1, originalContent);

    const contentHash = computeContentHash(originalContent);
    const editedAt = "2026-01-01T00:00:00Z";
    const editedBy = "test@test.com";
    const chainHash = computeChainHash(null, contentHash, 1, editedBy, editedAt);

    await tempStorage.writeHistory(docId, {
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
    });
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tempVault, { recursive: true });
  });

  it("current file hash matches history entry before any edit", async () => {
    const doc = await tempStorage.readDocument(docId);
    const currentHash = computeContentHash(doc.rawContent);
    const history = await tempStorage.readHistory(docId);
    expect(history).not.toBeNull();
    const latest = history!.versions[history!.versions.length - 1];
    expect(currentHash).toBe(latest.content_hash);
  });

  it("detects drift when current file edited directly on disk", async () => {
    const { writeFile } = await import("node:fs/promises");
    const filePath = join(tempVault, `${docId}.md`);

    // Bypass engine: rewrite file directly with different body
    const tamperedContent = originalContent.replace(
      "Original body.",
      "Tampered body — never went through writeDocument.",
    );
    await writeFile(filePath, tamperedContent, "utf-8");

    const doc = await tempStorage.readDocument(docId);
    const currentHash = computeContentHash(doc.rawContent);
    const history = await tempStorage.readHistory(docId);
    const latest = history!.versions[history!.versions.length - 1];

    // Engine does NOT auto-update history. Drift exposed via hash compare.
    expect(currentHash).not.toBe(latest.content_hash);
  });

  it("verifyDocumentChain still passes when only current file edited (keyframe untouched)", async () => {
    // Drift in current file does NOT corrupt keyframe chain — they are decoupled.
    const history = await tempStorage.readHistory(docId);
    const report = verifyDocumentChain(docId, history!, (v) => {
      // Synchronous read of keyframe — use the version we wrote in beforeAll
      if (v === 1) return originalContent;
      return null;
    });
    expect(report.valid).toBe(true);
  });

  it("verifyDocumentChain reports content_hash_mismatch when keyframe tampered", async () => {
    const history = await tempStorage.readHistory(docId);
    const report = verifyDocumentChain(docId, history!, (v) => {
      // Simulate someone editing .versions/v1.md directly
      if (v === 1) return originalContent.replace("Original body.", "Hacked.");
      return null;
    });
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.type === "content_hash_mismatch")).toBe(true);
  });

  it("verifyDocumentChain validates chain_hash on diff rows when keyframe content is unavailable", async () => {
    // Regression: a stub readKeyframe returning null for every version must
    // NOT cause cascading chain_hash_mismatch on subsequent diff rows.
    // The chain_hash check uses stored content_hash and must run regardless.
    const history = await tempStorage.readHistory(docId);
    const report = verifyDocumentChain(docId, history!, () => null);
    expect(report.errors.some((e) => e.type === "chain_hash_mismatch")).toBe(false);
  });
});

// ─── deleteDocument Tests ────────────────────────────────────────────────────

describe("NestStorage.deleteDocument", () => {
  let tempVault: string;
  let tempStorage: NestStorage;

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    tempVault = await mkdtemp(join(tmpdir(), "contextnest-delete-test-"));
    tempStorage = new NestStorage(tempVault);
    await tempStorage.init("Delete Test Vault");

    // Create a test document
    const content = `---
title: "Delete Test"
type: document
status: draft
version: 1
---

# Delete Test
`;
    await tempStorage.writeDocument("nodes/delete-target", content);
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tempVault, { recursive: true });
  });

  it("deletes an existing document", async () => {
    const doc = await tempStorage.readDocument("nodes/delete-target");
    expect(doc.frontmatter.title).toBe("Delete Test");

    await tempStorage.deleteDocument("nodes/delete-target");

    await expect(tempStorage.readDocument("nodes/delete-target")).rejects.toThrow(
      DocumentNotFoundError,
    );
  });

  it("throws DocumentNotFoundError for missing document", async () => {
    await expect(tempStorage.deleteDocument("nodes/nonexistent")).rejects.toThrow(
      DocumentNotFoundError,
    );
  });

  it("cleans up .versions/ directory", async () => {
    // Create doc with version history
    const content = `---
title: "Version Delete Test"
type: document
status: draft
version: 1
---

# Version Delete Test
`;
    await tempStorage.writeDocument("nodes/version-delete", content);

    // Write a fake history file
    await tempStorage.writeHistory("nodes/version-delete", {
      keyframe_interval: 10,
      versions: [
        {
          version: 1,
          keyframe: true,
          edited_by: "test",
          edited_at: new Date().toISOString(),
          content_hash: "sha256:" + "a".repeat(64),
          chain_hash: "sha256:" + "b".repeat(64),
        },
      ],
    });

    const history = await tempStorage.readHistory("nodes/version-delete");
    expect(history).not.toBeNull();

    await tempStorage.deleteDocument("nodes/version-delete");

    const historyAfter = await tempStorage.readHistory("nodes/version-delete");
    expect(historyAfter).toBeNull();
  });
});

// ─── publishDocument seed-on-first-publish (Bug 4) ─────────────────────────

describe("publishDocument auto-seed for pre-existing frontmatter version", () => {
  let tempVault: string;
  let tempStorage: NestStorage;

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    tempVault = await mkdtemp(join(tmpdir(), "cn-seed-"));
    tempStorage = new NestStorage(tempVault);
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tempVault, { recursive: true, force: true });
  });

  it("seeds pre-publish version when frontmatter.version > 1 and no history exists", async () => {
    const docId = "nodes/migrated-doc";
    const preBody = "# Migrated Doc\n\nOriginal pre-session body.\n";
    const initial = `---
title: Migrated Doc
type: document
status: published
version: 3
---

${preBody}`;
    await tempStorage.writeDocument(docId, initial);

    await publishDocument(tempStorage, docId, {
      editedBy: "tester@local",
      note: "first session publish",
    });

    const history = await tempStorage.readHistory(docId);
    expect(history).not.toBeNull();
    const versions = history!.versions.map((v) => v.version).sort((a, b) => a - b);
    expect(versions).toContain(3);
    expect(versions).toContain(4);

    const seedEntry = history!.versions.find((v) => v.version === 3);
    expect(seedEntry?.edited_by).toBe("system:seed");
    expect(seedEntry?.keyframe).toBe(true);

    const vm = new VersionManager(tempStorage);
    const v3Content = await vm.reconstructVersion(docId, 3);
    expect(v3Content).toContain("Original pre-session body");
  });

  it("does NOT seed when frontmatter.version <= 1", async () => {
    const docId = "nodes/fresh-doc";
    const initial = `---
title: Fresh Doc
type: document
status: draft
---

# Fresh Doc

Body.
`;
    await tempStorage.writeDocument(docId, initial);

    await publishDocument(tempStorage, docId, { editedBy: "tester@local" });

    const history = await tempStorage.readHistory(docId);
    expect(history!.versions.length).toBe(1);
    expect(history!.versions[0].version).toBe(1);
    expect(history!.versions[0].edited_by).toBe("tester@local");
  });
});
