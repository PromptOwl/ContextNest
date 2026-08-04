import { describe, it, expect } from "vitest";
import { parseDocument, serializeDocument, normalizeTags } from "../parser.js";
import type { ContextNode } from "../types.js";

/**
 * Regression test — engine serializer must not choke on undefined frontmatter.
 *
 * `serializeDocument` (matter.stringify → js-yaml) threw
 *   "unacceptable kind of an object to dump [object Undefined]"
 * on any frontmatter key whose value is `undefined`. Those values are produced
 * by the engine's OWN parser: `normalizeTags([])` returns `undefined`, and
 * `parseDocument` writes that back into `frontmatter.tags`. So a doc authored
 * with `tags: []` round-tripped through parse→serialize crashed.
 *
 * The community server carried a `safePublishDocument` wrapper (deep-strip
 * undefined → re-serialize) purely to dodge this. Fixing it here lets that
 * wrapper be deleted. Seam #4 of the engine↔community separation.
 */
describe("serializeDocument — undefined frontmatter values", () => {
  it("normalizeTags returns undefined for empty tags (the trigger)", () => {
    expect(normalizeTags([])).toBeUndefined();
  });

  it("does not throw when a frontmatter value is undefined", () => {
    const node: ContextNode = {
      id: "x",
      frontmatter: { title: "T", tags: undefined, status: "draft" } as ContextNode["frontmatter"],
      body: "hello",
    } as ContextNode;
    expect(() => serializeDocument(node)).not.toThrow();
  });

  it("omits the undefined key rather than emitting it", () => {
    const node: ContextNode = {
      id: "x",
      frontmatter: { title: "T", tags: undefined, status: "draft" } as ContextNode["frontmatter"],
      body: "hello",
    } as ContextNode;
    const out = serializeDocument(node);
    expect(out).not.toContain("tags:");
    expect(out).toContain("title: T");
  });

  it("round-trips a document authored with empty tags", () => {
    const authored = "---\ntitle: Empty Tags\ntags: []\nstatus: draft\n---\nbody text\n";
    const parsed = parseDocument("nodes/empty.md", authored, "nodes/empty");
    // parseDocument set frontmatter.tags to undefined via normalizeTags([])
    expect(parsed.frontmatter.tags).toBeUndefined();
    // Serializing must not throw and must be re-parseable.
    const serialized = serializeDocument(parsed);
    const reparsed = parseDocument("nodes/empty.md", serialized, "nodes/empty");
    expect(reparsed.frontmatter.title).toBe("Empty Tags");
    expect(reparsed.body.trim()).toBe("body text");
  });
});
