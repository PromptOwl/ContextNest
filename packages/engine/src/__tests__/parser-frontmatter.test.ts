import { describe, it, expect } from "vitest";
import { parseDocument, serializeDocument } from "../index.js";

/**
 * Pins the frontmatter split/serialize behaviour that replaced gray-matter.
 * Every document read and write goes through it, and its edge cases were
 * previously only exercised incidentally through other suites.
 */
describe("splitFrontmatter", () => {
  const parse = (content: string) => parseDocument("/x.md", content, "x");

  it("strips a UTF-8 BOM before looking for the delimiter", () => {
    const node = parse('﻿---\ntitle: "BOM"\ntype: document\n---\n\nBody.\n');
    expect(node.frontmatter.title).toBe("BOM");
    expect(node.body.trim()).toBe("Body.");
  });

  it("treats a longer rule as a thematic break, not a delimiter", () => {
    for (const rule of ["----", "-----"]) {
      const node = parse(`${rule}\ntitle: "Not frontmatter"\n${rule}\n\nBody.\n`);
      expect(node.frontmatter.title).toBeUndefined();
      expect(node.body).toContain(rule);
    }
  });

  it("treats a comment-only block as empty frontmatter", () => {
    const node = parse("---\n# just a comment\n# and another\n---\n\nBody.\n");
    expect(node.frontmatter.title).toBeUndefined();
    expect(node.body.trim()).toBe("Body.");
  });

  it("handles a document with no frontmatter at all", () => {
    const node = parse("# Obsidian Note\n\nNo frontmatter here.\n");
    expect(node.frontmatter.title).toBeUndefined();
    expect(node.body).toContain("No frontmatter here.");
  });

  it("handles an unterminated frontmatter block", () => {
    const node = parse('---\ntitle: "Unterminated"\ntype: document\n');
    expect(node.frontmatter.title).toBe("Unterminated");
    expect(node.body).toBe("");
  });

  it("consumes only the closing delimiter's own line ending, CRLF included", () => {
    // The blank line between frontmatter and content belongs to the body, so
    // exactly one terminator is stripped — matching what gray-matter did.
    const crlf = parse('---\r\ntitle: "CRLF"\r\ntype: document\r\n---\r\n\r\n# CRLF\r\n');
    expect(crlf.frontmatter.title).toBe("CRLF");
    expect(crlf.body).toBe("\r\n# CRLF\r\n");

    const lf = parse('---\ntitle: "LF"\ntype: document\n---\n\n# LF\n');
    expect(lf.body).toBe("\n# LF\n");
  });

  it("keeps an ISO timestamp as a string rather than a Date", () => {
    const node = parse(
      '---\ntitle: "Dates"\ntype: document\nupdated_at: 2024-02-01T14:22:00Z\n---\n\nBody.\n',
    );
    expect(typeof node.frontmatter.updated_at).toBe("string");
  });

  it("writes a bare body when frontmatter serializes to nothing", () => {
    const serialized = serializeDocument({
      id: "x",
      filePath: "/x.md",
      frontmatter: {} as never,
      body: "Just a body.",
      rawContent: "",
    });
    expect(serialized).toBe("Just a body.\n");
    expect(serialized.startsWith("---")).toBe(false);
  });

  it("round-trips a body that itself contains a horizontal rule", () => {
    const original = '---\ntitle: "Rules"\ntype: document\n---\n\nAbove.\n\n---\n\nBelow.\n';
    const node = parse(original);
    expect(node.body).toContain("---");
    const reparsed = parse(serializeDocument(node));
    expect(reparsed.frontmatter.title).toBe("Rules");
    expect(reparsed.body).toContain("Above.");
    expect(reparsed.body).toContain("Below.");
  });
});
