import { describe, it, expect } from "vitest";
import { parseDocument } from "../parser.js";
import { generateIndexMd } from "../index-md-generator.js";

/**
 * Regression test for the MCP-server-reported bug:
 *
 *   "doc.frontmatter.updated_at.split is not a function"
 *
 * Cause: gray-matter (js-yaml DEFAULT_SCHEMA) auto-parses an unquoted ISO
 * timestamp in YAML frontmatter into a JavaScript `Date` object. Downstream
 * code (notably `generateIndexMd`) called `.split("T")[0]` on it and crashed.
 * The crash fired AFTER `update_document` had already committed a new
 * version, so each retry bumped the version (1 → 2 → 3 …).
 */
describe("Bug fix: updated_at coerced to string regardless of YAML shape", () => {
  it("parseDocument coerces an auto-parsed Date in updated_at to an ISO string", () => {
    // Note: NO quotes around the date — triggers js-yaml's Date auto-parse.
    const raw =
      "---\n" +
      "title: Test Doc\n" +
      "version: 1\n" +
      "updated_at: 2026-04-19T12:00:00.000Z\n" +
      "---\n" +
      "body\n";
    const node = parseDocument("/abs/test.md", raw, "nodes/test");
    expect(typeof node.frontmatter.updated_at).toBe("string");
    expect(node.frontmatter.updated_at).toBe("2026-04-19T12:00:00.000Z");
  });

  it("parseDocument also coerces created_at", () => {
    const raw =
      "---\n" +
      "title: Test Doc\n" +
      "created_at: 2026-01-01T00:00:00.000Z\n" +
      "---\n" +
      "body\n";
    const node = parseDocument("/abs/test.md", raw, "nodes/test");
    expect(typeof node.frontmatter.created_at).toBe("string");
  });

  it("parseDocument leaves quoted-string updated_at unchanged", () => {
    const raw =
      "---\n" +
      "title: Test Doc\n" +
      "updated_at: '2026-04-19T12:00:00.000Z'\n" +
      "---\n" +
      "body\n";
    const node = parseDocument("/abs/test.md", raw, "nodes/test");
    expect(node.frontmatter.updated_at).toBe("2026-04-19T12:00:00.000Z");
  });

  it("generateIndexMd does not crash on a Date-typed updated_at (defensive layer)", () => {
    // Simulate the pre-fix shape directly: pass a Date through the type
    // gap to ensure the formatter does not call .split on it.
    const fauxNode = {
      id: "nodes/test",
      filePath: "/abs/test.md",
      frontmatter: {
        title: "Faux Doc",
        type: "document" as const,
        status: "published" as const,
        tags: [],
        // Cast through unknown — what the bug ACTUALLY looked like at runtime.
        updated_at: new Date(
          "2026-04-19T12:00:00.000Z",
        ) as unknown as string,
      },
      body: "x",
      rawContent: "raw",
    };
    expect(() =>
      generateIndexMd("nodes", "Nodes", [fauxNode], []),
    ).not.toThrow();
    const md = generateIndexMd("nodes", "Nodes", [fauxNode], []);
    expect(md).toContain("2026-04-19");
  });

  it("generateIndexMd renders a date cell from a normalized string updated_at", () => {
    const raw =
      "---\n" +
      "title: Real Doc\n" +
      "type: document\n" +
      "status: published\n" +
      "updated_at: 2026-04-19T12:00:00.000Z\n" +
      "---\n" +
      "body\n";
    const node = parseDocument("/abs/real.md", raw, "nodes/real");
    const md = generateIndexMd("nodes", "Nodes", [node], []);
    expect(md).toContain("2026-04-19");
  });

  it("generateIndexMd falls back to 'now' for missing updated_at", () => {
    const raw =
      "---\n" +
      "title: No Date Doc\n" +
      "type: document\n" +
      "status: published\n" +
      "---\n" +
      "body\n";
    const node = parseDocument("/abs/x.md", raw, "nodes/x");
    expect(() => generateIndexMd("nodes", "Nodes", [node], [])).not.toThrow();
  });
});
