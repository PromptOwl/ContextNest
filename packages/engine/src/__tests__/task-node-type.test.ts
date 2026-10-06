/**
 * `task` node type: a board work item. It is pure vocabulary — no structural
 * block, no type-specific rule — so it must validate exactly like `document`,
 * board fields in `metadata` included, and round-trip through the parser.
 */
import { describe, it, expect } from "vitest";
import { NODE_TYPES } from "../schemas.js";
import { parseDocument, serializeDocument, validateDocument } from "../parser.js";
import type { ContextNode, Frontmatter } from "../types.js";

function taskNode(metadata: Record<string, unknown> = {}): ContextNode {
  const frontmatter: Frontmatter = {
    title: "Ship onboarding email",
    type: "task",
    tags: ["#doing"],
    status: "published",
    version: 1,
    created_at: "2026-10-06T00:00:00.000Z",
    updated_at: "2026-10-06T00:00:00.000Z",
    metadata,
  } as Frontmatter;
  return { id: "nodes/ship-onboarding-email", filePath: "", rawContent: "", frontmatter, body: "\nDraft and send.\n" };
}

describe("task node type", () => {
  it("is in the vocabulary", () => {
    expect(NODE_TYPES).toContain("task");
  });

  it("validates with board fields in metadata", () => {
    const r = validateDocument(
      taskNode({
        assignee: "a@example.com",
        assigned_at: "2026-10-06T10:00:00.000Z",
        due: "2026-10-10",
        priority: "high",
        parent: "nodes/onboarding-epic",
      }),
    );
    expect(r.errors).toEqual([]);
  });

  it("round-trips through serialize/parse with its type and metadata intact", () => {
    const node = taskNode({ assignee: "a@example.com", priority: "urgent" });
    const parsed = parseDocument("nodes/ship-onboarding-email.md", serializeDocument(node), node.id);
    expect(parsed.frontmatter.type).toBe("task");
    expect((parsed.frontmatter.metadata as any).assignee).toBe("a@example.com");
    expect((parsed.frontmatter.metadata as any).priority).toBe("urgent");
  });
});
