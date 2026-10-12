import { describe, it, expect } from "vitest";
import { rerootForDiscovery, countHeldMatches, heldSearchHint } from "../onboarding-hints.js";

describe("rerootForDiscovery", () => {
  it("leaves ids under nodes/ and sources/ alone", () => {
    expect(rerootForDiscovery("nodes/a", "structured")).toEqual({ id: "nodes/a", rerooted: false });
    expect(rerootForDiscovery("sources/cfg", "structured")).toEqual({ id: "sources/cfg", rerooted: false });
  });

  it("re-roots a folder discovery never scans under nodes/ (structured layout)", () => {
    expect(rerootForDiscovery("notes/beta", "structured")).toEqual({ id: "nodes/notes/beta", rerooted: true });
    expect(rerootForDiscovery("gtm/plans/q4", "structured")).toEqual({ id: "nodes/gtm/plans/q4", rerooted: true });
  });

  it("never re-roots in an obsidian vault, where every folder is discovered", () => {
    expect(rerootForDiscovery("notes/beta", "obsidian")).toEqual({ id: "notes/beta", rerooted: false });
  });
});

describe("countHeldMatches", () => {
  const doc = (status: string, title: string, body: string, tags: string[] = []) => ({
    frontmatter: { status, title, tags },
    body,
  });
  const docs = [
    doc("pending_review", "Zebra policy", "stripes"),
    doc("pending_review", "Other", "nothing here", ["zebra"]),
    doc("published", "Zebra live", "zebra"),
    doc("draft", "Zebra draft", "zebra"),
    doc("pending_review", "Unrelated", "lions"),
  ];

  it("counts only pending_review documents matching a query term (title, body or tags)", () => {
    expect(countHeldMatches(docs, "zebra")).toBe(2);
    expect(countHeldMatches(docs, "ZEBRA lions")).toBe(3);
    expect(countHeldMatches(docs, "giraffe")).toBe(0);
  });
});

describe("heldSearchHint", () => {
  it("names the count and the command that lists held writes", () => {
    expect(heldSearchHint(1)).toBe("1 matching document is held for review and not searchable until approved: ctx review list");
    expect(heldSearchHint(2)).toBe("2 matching documents are held for review and not searchable until approved: ctx review list");
  });
});
