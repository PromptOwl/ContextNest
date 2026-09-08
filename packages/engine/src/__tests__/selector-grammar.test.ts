/**
 * Selector grammar (§2) — lexer/parser regression + bare node ids.
 *
 * Part 1 pins the grammar that already worked BEFORE bare node ids were added
 * (`#a + #b`, `|`, `-`, `( )`, `contextnest://…`, quoted atoms, every
 * `word:` filter). Part 2 covers the new bare-id form (`nodes/<id>`,
 * `sources/<id>` lex as a URI atom), the "did you mean" error for a bare word
 * without that prefix, the unknown-filter error listing the valid filters,
 * and the single exported grammar line every surface renders.
 *
 * [CU-wdqcq01c5x]
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseSelector } from "../selector/parser.js";
import { tokenize } from "../selector/lexer.js";
import { InvalidSelectorError } from "../errors.js";
import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { VersionManager } from "../versioning.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import { generateContextYaml } from "../index-generator.js";
import { createEngineApi, listOperations } from "../api/index.js";
import * as engine from "../index.js";
import type { ContextNode, Frontmatter, SourceMeta } from "../types.js";

// ─── Part 1: existing grammar (must pass before AND after the lexer change) ──

describe("selector grammar — existing forms still parse", () => {
  const cases: Array<[string, unknown]> = [
    ["#a", { type: "tag", value: "a" }],
    ["#a + #b", { type: "and", left: { type: "tag", value: "a" }, right: { type: "tag", value: "b" } }],
    ["#a #b", { type: "and", left: { type: "tag", value: "a" }, right: { type: "tag", value: "b" } }],
    ["#a | #b", { type: "or", left: { type: "tag", value: "a" }, right: { type: "tag", value: "b" } }],
    ["#a - #b", { type: "not", left: { type: "tag", value: "a" }, right: { type: "tag", value: "b" } }],
    [
      "(#a | #b) + #c",
      {
        type: "and",
        left: { type: "or", left: { type: "tag", value: "a" }, right: { type: "tag", value: "b" } },
        right: { type: "tag", value: "c" },
      },
    ],
    ["contextnest://nodes/api-design", { type: "uri", value: "contextnest://nodes/api-design" }],
    ["contextnest://tag/api", { type: "uri", value: "contextnest://tag/api" }],
    ["contextnest://nodes/api-design@3", { type: "uri", value: "contextnest://nodes/api-design@3" }],
    [
      "contextnest://nodes/api - #old",
      {
        type: "not",
        left: { type: "uri", value: "contextnest://nodes/api" },
        right: { type: "tag", value: "old" },
      },
    ],
    ['"contextnest://nodes/x"', { type: "uri", value: "contextnest://nodes/x" }],
    ['"#quoted"', { type: "tag", value: "quoted" }],
    ['"pack:onboarding.basics"', { type: "pack", value: "onboarding.basics" }],
    ["type:document", { type: "typeFilter", value: "document" }],
    ["status:published", { type: "statusFilter", value: "published" }],
    ["pack:onboarding.basics", { type: "pack", value: "onboarding.basics" }],
    ["tag:#api", { type: "tag", value: "api" }],
    ["tag:api", { type: "tag", value: "api" }],
    ["transport:mcp", { type: "transportFilter", value: "mcp" }],
    ["server:github", { type: "serverFilter", value: "github" }],
    [
      "type:skill + #engineering",
      {
        type: "and",
        left: { type: "typeFilter", value: "skill" },
        right: { type: "tag", value: "engineering" },
      },
    ],
    [
      "#onboarding type:document",
      {
        type: "and",
        left: { type: "tag", value: "onboarding" },
        right: { type: "typeFilter", value: "document" },
      },
    ],
  ];

  it.each(cases)("parses %s", (input, expected) => {
    expect(parseSelector(input)).toEqual(expected);
  });

  it("precedence: () > + (AND) > - (NOT) > | (OR)", () => {
    // `#a + #b - #c | #d` → or(not(and(a,b), c), d)
    expect(parseSelector("#a + #b - #c | #d")).toEqual({
      type: "or",
      left: {
        type: "not",
        left: { type: "and", left: { type: "tag", value: "a" }, right: { type: "tag", value: "b" } },
        right: { type: "tag", value: "c" },
      },
      right: { type: "tag", value: "d" },
    });
  });

  it("still rejects an empty tag and an unbalanced paren", () => {
    expect(() => parseSelector("#")).toThrow(InvalidSelectorError);
    expect(() => parseSelector("(#a")).toThrow(InvalidSelectorError);
  });
});

// ─── Part 2: bare node ids ───────────────────────────────────────────────────

describe("selector grammar — bare node ids (nodes/<id>, sources/<id>)", () => {
  it('parseSelector("nodes/gtm/foo") yields a uri atom with the scheme prepended', () => {
    expect(parseSelector("nodes/gtm/foo")).toEqual({
      type: "uri",
      value: "contextnest://nodes/gtm/foo",
    });
  });

  it("sources/<id> lexes the same way", () => {
    expect(parseSelector("sources/github-issues")).toEqual({
      type: "uri",
      value: "contextnest://sources/github-issues",
    });
  });

  it("keeps hyphens, dots, digits and @N pins inside the id", () => {
    expect(parseSelector("nodes/api-v2.1_final")).toEqual({
      type: "uri",
      value: "contextnest://nodes/api-v2.1_final",
    });
    expect(parseSelector("nodes/api@3")).toEqual({
      type: "uri",
      value: "contextnest://nodes/api@3",
    });
  });

  it("nodes/gtm/foo + #strategy parses as AND", () => {
    expect(parseSelector("nodes/gtm/foo + #strategy")).toEqual({
      type: "and",
      left: { type: "uri", value: "contextnest://nodes/gtm/foo" },
      right: { type: "tag", value: "strategy" },
    });
  });

  it("terminates on whitespace, +, |, ( and ) — and ` - ` is NOT, mirroring the contextnest:// branch", () => {
    expect(parseSelector("nodes/a|#b")).toEqual({
      type: "or",
      left: { type: "uri", value: "contextnest://nodes/a" },
      right: { type: "tag", value: "b" },
    });
    expect(parseSelector("nodes/a+#b")).toEqual({
      type: "and",
      left: { type: "uri", value: "contextnest://nodes/a" },
      right: { type: "tag", value: "b" },
    });
    expect(parseSelector("(nodes/a) #b")).toEqual({
      type: "and",
      left: { type: "uri", value: "contextnest://nodes/a" },
      right: { type: "tag", value: "b" },
    });
    expect(parseSelector("nodes/a - #b")).toEqual({
      type: "not",
      left: { type: "uri", value: "contextnest://nodes/a" },
      right: { type: "tag", value: "b" },
    });
    // Same as `contextnest://nodes/a-b`: the hyphen is part of the id.
    expect(parseSelector("nodes/a-b")).toEqual({ type: "uri", value: "contextnest://nodes/a-b" });
  });

  it("a QUOTED bare id gets the scheme too (review on PR #100)", () => {
    expect(parseSelector('"nodes/gtm/foo"')).toEqual({
      type: "uri",
      value: "contextnest://nodes/gtm/foo",
    });
    expect(parseSelector('"sources/feed"')).toEqual({
      type: "uri",
      value: "contextnest://sources/feed",
    });
    expect(parseSelector('"nodes/gtm/foo" | nodes/other')).toEqual({
      type: "or",
      left: { type: "uri", value: "contextnest://nodes/gtm/foo" },
      right: { type: "uri", value: "contextnest://nodes/other" },
    });
  });

  it("a QUOTED word without the prefix gets the same hint, not an opaque INVALID_URI", () => {
    // The quoted spelling used to lex as URI "gtm/foo" and fail later in
    // parseUri with `URI must start with contextnest://`. Same mistake as the
    // unquoted form, so it must produce the same error. (review on PR #100)
    let quoted = "";
    try {
      parseSelector('\"gtm/foo\"');
    } catch (e) {
      quoted = (e as Error).message;
    }
    let bare = "";
    try {
      parseSelector("gtm/foo");
    } catch (e) {
      bare = (e as Error).message;
    }
    expect(quoted).toBe(bare);
    expect(() => parseSelector('\"gtm/foo\"')).toThrow(InvalidSelectorError);
    expect(quoted).toContain('did you mean "nodes/gtm/foo"');
    // A quoted mis-cased prefix is hinted the same way too.
    expect(() => parseSelector('\"Nodes/foo\"')).toThrow(/did you mean "nodes\/foo"/);
  });

  it("a mis-cased prefix (Nodes/foo) is hinted as nodes/foo, never nodes/Nodes/foo", () => {
    let msg = "";
    try {
      parseSelector("Nodes/foo");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Unexpected token "Nodes/foo" at position 0');
    expect(msg).toContain('did you mean "nodes/foo"');
    expect(msg).not.toContain("nodes/Nodes");
    expect(() => parseSelector("SOURCES/feed")).toThrow(/did you mean "sources\/feed"/);
  });

  it("emits a URI token whose position is where the bare id started", () => {
    const tokens = tokenize("#x nodes/y");
    expect(tokens[1]).toEqual({ type: "URI", value: "contextnest://nodes/y", position: 3 });
  });

  it('a bare word without the prefix throws INVALID_SELECTOR with a "did you mean" hint', () => {
    let err: unknown;
    try {
      parseSelector("gtm/foo");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidSelectorError);
    const msg = (err as Error).message;
    expect(msg).toBe(
      'Unexpected token "gtm/foo" at position 0 — did you mean "nodes/gtm/foo" (a node id) or "#gtm/foo" (a tag)?',
    );
  });

  it("the hint names the whole offending word, not just its first segment", () => {
    expect(() => parseSelector("#a + api-design")).toThrow(
      /Unexpected token "api-design" at position 5 — did you mean "nodes\/api-design" \(a node id\) or "#api-design" \(a tag\)\?/,
    );
  });

  it("an unknown filter lists the valid filters", () => {
    expect(() => parseSelector("folder:nodes")).toThrow(InvalidSelectorError);
    expect(() => parseSelector("folder:nodes")).toThrow(
      /Unknown filter "folder" at position 0 — valid filters: type, status, tag, pack, transport, server/,
    );
    expect(() => parseSelector("path:nodes/api")).toThrow(/valid filters: type, status, tag, pack, transport, server/);
    expect(() => parseSelector("id:nodes/api")).toThrow(/valid filters: type, status, tag, pack, transport, server/);
  });

  it("`&` is still not an operator (the grammar's AND is a space or +)", () => {
    expect(() => parseSelector("#a & #b")).toThrow(InvalidSelectorError);
  });
});

// ─── Part 3: one canonical grammar line ──────────────────────────────────────

describe("SELECTOR_GRAMMAR", () => {
  it("is exported from the engine and names every atom and operator", () => {
    const g = (engine as Record<string, unknown>).SELECTOR_GRAMMAR;
    expect(typeof g).toBe("string");
    for (const piece of ["#tag", "type:X", "status:X", "pack:id", "nodes/<id>", "sources/<id>", "AND", "OR", "NOT", "( )"]) {
      expect(g).toContain(piece);
    }
    expect(g).not.toContain("&");
    expect(g).not.toContain("path:");
  });

  it("is carried by BOTH selector-taking MCP tool descriptions, not just one", () => {
    // context_resolve used to describe the token budget and nothing about the
    // grammar, so an agent calling it never learned the bare-id atom.
    for (const name of ["context_query", "context_resolve"]) {
      const op = listOperations("core").find((o) => o.name === name);
      expect(op, name).toBeDefined();
      expect(op!.description).toContain(engine.SELECTOR_GRAMMAR);
    }
  });
});

// ─── Part 4: through the engine ──────────────────────────────────────────────

describe("bare node ids through the query engine", () => {
  let vaultPath: string;
  let storage: NestStorage;

  async function addDoc(id: string, tags: string[], publish = true): Promise<void> {
    const frontmatter: Frontmatter = {
      title: id,
      type: "document",
      status: "draft",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      tags: tags.map((t) => (t.startsWith("#") ? t : `#${t}`)),
    };
    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter,
      body: `\n# ${id}\n\nBody of ${id}.\n`,
      rawContent: "",
    };
    await storage.writeDocument(id, serializeDocument(node));
    if (publish) await publishDocument(storage, id, { editedBy: "test@local", note: "test" });
  }

  async function addSource(id: string): Promise<void> {
    const source: SourceMeta = { transport: "mcp", server: "jira", tools: ["list_issues"] };
    const frontmatter: Frontmatter = {
      title: id,
      type: "source",
      status: "draft",
      version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      tags: ["#strategy"],
      source,
    };
    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter,
      body: `\n# ${id}\n\nBody of ${id}.\n`,
      rawContent: "",
    };
    await storage.writeDocument(id, serializeDocument(node));
    await publishDocument(storage, id, { editedBy: "test@local", note: "test" });
  }

  async function reindex(): Promise<void> {
    const docs = await storage.discoverDocuments();
    const config = await storage.readConfig();
    const history = await storage.readCheckpointHistory();
    const latest = history?.checkpoints?.at(-1) ?? null;
    const published = docs.filter((d) => d.frontmatter.status === "published");
    await storage.writeContextYaml(generateContextYaml(published, config, latest));
  }

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "contextnest-selector-bare-"));
    storage = new NestStorage(vaultPath);
    await storage.init("Bare Id Vault");
    await addDoc("nodes/gtm/foo", ["strategy"]);
    await addDoc("nodes/gtm/bar", ["strategy"]);
    await addDoc("nodes/gtm/foo-draft", ["strategy"], false);
    await addSource("sources/jira");
    await reindex();
  });

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  it('query("nodes/gtm/foo", {hops:0}) returns exactly that published doc', async () => {
    const gqe = new GraphQueryEngine(storage);
    const result = await gqe.query("nodes/gtm/foo", { hops: 0 });
    expect(result.documents.map((d) => d.id)).toEqual(["nodes/gtm/foo"]);
  });

  it("nodes/gtm/foo + #strategy narrows to the one doc; nodes/gtm/foo | nodes/gtm/bar unions", async () => {
    const gqe = new GraphQueryEngine(storage);
    const and = await gqe.query("nodes/gtm/foo + #strategy", { hops: 0 });
    expect(and.documents.map((d) => d.id)).toEqual(["nodes/gtm/foo"]);
    const or = await gqe.query("nodes/gtm/foo | nodes/gtm/bar", { hops: 0 });
    expect(or.documents.map((d) => d.id).sort()).toEqual(["nodes/gtm/bar", "nodes/gtm/foo"]);
  });

  it("the quoted form resolves the same doc as the unquoted form", async () => {
    const gqe = new GraphQueryEngine(storage);
    const quoted = await gqe.query('"nodes/gtm/foo"', { hops: 0 });
    const bare = await gqe.query("nodes/gtm/foo", { hops: 0 });
    expect(quoted.documents.map((d) => d.id)).toEqual(bare.documents.map((d) => d.id));
    expect(quoted.documents.map((d) => d.id)).toEqual(["nodes/gtm/foo"]);
  });

  it("sources/<id> resolves the source node, not a document", async () => {
    // The other half of the atom: `sources/` nodes come back on sourceNodes,
    // so a lexer-only assertion would not have caught a storage/evaluator gap.
    const gqe = new GraphQueryEngine(storage);
    const result = await gqe.query("sources/jira", { hops: 0 });
    expect(result.sourceNodes.map((d) => d.id)).toEqual(["sources/jira"]);
    expect(result.documents).toEqual([]);
    const long = await gqe.query("contextnest://sources/jira", { hops: 0 });
    expect(long.sourceNodes.map((d) => d.id)).toEqual(["sources/jira"]);
  });

  it("context_resolve lists it", async () => {
    const api = createEngineApi();
    const out = await api.run<{ documents: Array<{ id: string }> }>(
      "context_resolve",
      { selector: "nodes/gtm/foo", hops: 0 },
      {
        storage,
        query: new GraphQueryEngine(storage),
        versions: new VersionManager(storage),
        actor: "tester@example.com",
      },
    );
    expect(out.documents.map((d) => d.id)).toEqual(["nodes/gtm/foo"]);
  });

  it("context_query surfaces the did-you-mean hint as INVALID_SELECTOR", async () => {
    const api = createEngineApi();
    await expect(
      api.run(
        "context_query",
        { query: "gtm/foo", hops: 0 },
        {
          storage,
          query: new GraphQueryEngine(storage),
          versions: new VersionManager(storage),
          actor: "tester@example.com",
        },
      ),
    ).rejects.toThrow(/nodes\/gtm\/foo/);
  });
});
