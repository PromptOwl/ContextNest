/**
 * [[wikilinks]] become `reference` edges at index time [CU-wdqcq01c60].
 *
 * Before this, `buildRelationships()` only saw `contextnest://` inline links
 * and `depends_on`, so a vault authored with `[[Title]]` links (the common
 * Obsidian/wiki style) produced zero relationships in context.yaml and
 * `--hops` was a no-op. These tests pin the contract:
 *
 *   1. `[[Title]]` (exact / case-insensitive) and `[[nodes/id]]` resolve to a
 *      `reference` edge from the linking doc to the target.
 *   2. Unresolvable targets produce no edge but are counted in stats.
 *   3. A doc linking the same target via `contextnest://` AND `[[..]]` yields
 *      exactly one edge (dedupe by from/to/type).
 *   4. `buildBacklinks` sees the same edges, so the engine backlinks API and
 *      context.yaml never disagree.
 *   5. A graph query seeded on the linking doc reaches the target in 1 hop.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NestStorage } from "../storage.js";
import { GraphQueryEngine } from "../graph-query-engine.js";
import { publishDocument } from "../publish.js";
import { serializeDocument } from "../parser.js";
import {
  generateContextYaml,
  generateContextYamlWithStats,
} from "../index-generator.js";
import {
  buildRelationships,
  buildRelationshipsWithStats,
  buildBacklinks,
} from "../inline.js";
import type { ContextNode, Frontmatter, RelationshipEdge } from "../types.js";

/** In-memory published doc — enough for buildRelationships / generateContextYaml. */
function doc(id: string, title: string, body: string): ContextNode {
  const frontmatter: Frontmatter = {
    title,
    type: "document",
    status: "published",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  return { id, filePath: "", frontmatter, body, rawContent: "" };
}

const refEdges = (edges: RelationshipEdge[], from: string) =>
  edges.filter((e) => e.from === from && e.type === "reference").map((e) => e.to);

describe("buildRelationships — [[wikilinks]]", () => {
  it("AC1: [[B Title]] resolves by exact title to a reference edge A→B", () => {
    const a = doc("nodes/a", "A", "Read [[B Title]] first.");
    const b = doc("nodes/b", "B Title", "# B");
    const edges = buildRelationships([a, b]);
    expect(edges).toContainEqual({ from: "nodes/a", to: "nodes/b", type: "reference" });
  });

  it("resolves case-insensitively, by id, through an alias, and strips #anchors", () => {
    const a = doc(
      "nodes/a",
      "A",
      "[[b title]] [[nodes/c]] [[D Title|the d doc]] [[E Title#some-section]]",
    );
    const b = doc("nodes/b", "B Title", "");
    const c = doc("nodes/c", "C Title", "");
    const d = doc("nodes/d", "D Title", "");
    const e = doc("nodes/e", "E Title", "");
    const edges = buildRelationships([a, b, c, d, e]);
    expect(refEdges(edges, "nodes/a").sort()).toEqual([
      "nodes/b",
      "nodes/c",
      "nodes/d",
      "nodes/e",
    ]);
  });

  it("AC2: [[nodes/b]] resolves by id; [[Missing Page]] yields no edge and is counted", () => {
    const a = doc("nodes/a", "A", "See [[nodes/b]] and [[Missing Page]].");
    const b = doc("nodes/b", "B Title", "");
    const { edges, stats } = buildRelationshipsWithStats([a, b]);
    expect(refEdges(edges, "nodes/a")).toEqual(["nodes/b"]);
    expect(edges.some((e) => /missing/i.test(e.to))).toBe(false);
    expect(stats).toEqual({ edges: 1, fromWikilinks: 1, unresolvedWikilinks: 1 });
  });

  it("AC3: contextnest://nodes/b and [[B Title]] in the same doc dedupe to ONE edge", () => {
    const a = doc(
      "nodes/a",
      "A",
      "Inline [link](contextnest://nodes/b) and wiki [[B Title]].",
    );
    const b = doc("nodes/b", "B Title", "");
    const { edges, stats } = buildRelationshipsWithStats([a, b]);
    const toB = edges.filter(
      (e) => e.from === "nodes/a" && e.to === "nodes/b" && e.type === "reference",
    );
    expect(toB).toHaveLength(1);
    expect(stats.edges).toBe(1);
    // The inline link claimed the edge first; the wikilink was a duplicate.
    expect(stats.fromWikilinks).toBe(0);
    expect(stats.unresolvedWikilinks).toBe(0);
  });

  it("skips self-links and does not count them as unresolved", () => {
    const a = doc("nodes/a", "A Title", "I am [[A Title]] and [[nodes/a]].");
    const { edges, stats } = buildRelationshipsWithStats([a]);
    expect(edges).toEqual([]);
    expect(stats).toEqual({ edges: 0, fromWikilinks: 0, unresolvedWikilinks: 0 });
  });

  it("AC4: buildBacklinks sees wikilink edges (engine backlinks API stays consistent)", () => {
    const a = doc("nodes/a", "A", "[[B Title]]");
    const b = doc("nodes/b", "B Title", "");
    const backlinks = buildBacklinks([a, b]);
    expect(backlinks.get("nodes/b")).toEqual(["nodes/a"]);
  });

  // PR #97 review: a `#` inside a TITLE (`C#`, `Fix #123`) is not an anchor.
  // The whole target must be tried first; only a miss falls back to
  // stripping `#anchor`.
  it("resolves titles that contain '#' before treating '#' as an anchor", () => {
    const a = doc("nodes/a", "A", "[[C#]] [[Fix #123]] [[C# Guide#setup]]");
    const csharp = doc("nodes/csharp", "C#", "");
    const c = doc("nodes/c", "C", "");
    const fix = doc("nodes/fix-123", "Fix #123", "");
    const fixPrefix = doc("nodes/fix", "Fix", "");
    const guide = doc("nodes/csharp-guide", "C# Guide", "");
    const { edges, stats } = buildRelationshipsWithStats([a, csharp, c, fix, fixPrefix, guide]);
    expect(refEdges(edges, "nodes/a").sort()).toEqual([
      "nodes/csharp",
      "nodes/csharp-guide",
      "nodes/fix-123",
    ]);
    expect(stats.unresolvedWikilinks).toBe(0);
  });

  // PR #97 review: `extractContextLinks` masks fenced blocks and inline code;
  // wikilinks must too, or a doc that DOCUMENTS the syntax becomes a hub.
  it("ignores wikilinks inside fenced code blocks and inline code", () => {
    const body = [
      "Link syntax looks like `[[B Title]]` inline, or in a block:",
      "",
      "```md",
      "[[B Title]]",
      "```",
      "",
      "~~~",
      "[[C Title]]",
      "~~~",
    ].join("\n");
    const a = doc("nodes/a", "A", body);
    const b = doc("nodes/b", "B Title", "");
    const c = doc("nodes/c", "C Title", "");
    const { edges, stats } = buildRelationshipsWithStats([a, b, c]);
    expect(edges).toEqual([]);
    expect(stats).toEqual({ edges: 0, fromWikilinks: 0, unresolvedWikilinks: 0 });

    const plain = doc("nodes/a", "A", body + "\n\nBut a real [[B Title]] link counts.");
    expect(refEdges(buildRelationships([plain, b, c]), "nodes/a")).toEqual(["nodes/b"]);
  });
});

describe("generateContextYaml — wikilink edges, hubs and stats", () => {
  it("emits the wikilink edge in relationships and feeds hubs", () => {
    const a = doc("nodes/a", "A", "[[B Title]]");
    const c = doc("nodes/c", "C", "[[b title]]");
    const b = doc("nodes/b", "B Title", "");
    const yaml = generateContextYaml([a, b, c], null, null);
    expect(yaml.relationships).toContainEqual({ from: "nodes/a", to: "nodes/b", type: "reference" });
    expect(yaml.relationships).toContainEqual({ from: "nodes/c", to: "nodes/b", type: "reference" });
    expect(yaml.hubs[0]).toEqual({ id: "nodes/b", degree: 2 });
  });

  it("exposes {edges, fromWikilinks, unresolvedWikilinks}", () => {
    const a = doc(
      "nodes/a",
      "A",
      "[link](contextnest://nodes/c) [[B Title]] [[Nowhere]]",
    );
    const b = doc("nodes/b", "B Title", "");
    const c = doc("nodes/c", "C", "");
    const { contextYaml, stats } = generateContextYamlWithStats([a, b, c], null, null);
    expect(contextYaml.relationships).toHaveLength(2);
    expect(stats).toEqual({ edges: 2, fromWikilinks: 1, unresolvedWikilinks: 1 });
  });
});

describe("GraphQueryEngine — --hops follows wikilink edges", () => {
  let vaultPath: string;
  let storage: NestStorage;

  async function addDoc(id: string, title: string, body: string): Promise<void> {
    const node = doc(id, title, `\n${body}\n`);
    node.frontmatter.status = "draft";
    await storage.writeDocument(id, serializeDocument(node));
    await publishDocument(storage, id, { editedBy: "test@local", note: "test" });
  }

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "contextnest-wikilink-edges-"));
    storage = new NestStorage(vaultPath);
    await storage.init("Wikilink Edges Vault");
  });

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  it("AC1: querying contextnest://nodes/a with hops 1 returns B via [[B Title]]", async () => {
    await addDoc("nodes/a", "A", "Start here, then read [[B Title]].");
    await addDoc("nodes/b", "B Title", "# B");
    await addDoc("nodes/lonely", "Lonely", "Not linked from anywhere.");
    // The same regen every write goes through (add/update/publish --all), so
    // this exercises the real index path rather than a hand-rolled reindex.
    await storage.regenerateIndex();
    const yaml = await storage.readContextYaml();
    expect(yaml?.relationships).toContainEqual({
      from: "nodes/a",
      to: "nodes/b",
      type: "reference",
    });

    const engine = new GraphQueryEngine(storage);
    const result = await engine.query("contextnest://nodes/a", { hops: 1 });
    expect(result.mode).toBe("graph");
    const ids = result.documents.map((d) => d.id);
    expect(ids).toContain("nodes/a");
    expect(ids).toContain("nodes/b");
    expect(ids).not.toContain("nodes/lonely");
  });
});
