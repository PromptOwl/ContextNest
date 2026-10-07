import { describe, it, expect } from "vitest";
import { rerootForDiscovery, heldReviewNotice } from "../onboarding-hints.js";

describe("rerootForDiscovery", () => {
  it("re-roots an id outside nodes/ and sources/ in a structured vault", () => {
    expect(rerootForDiscovery("projects/plan", "structured")).toEqual({ id: "nodes/projects/plan", rerooted: true });
  });

  it("leaves ids already under a discovered root alone", () => {
    expect(rerootForDiscovery("nodes/plan", "structured")).toEqual({ id: "nodes/plan", rerooted: false });
    expect(rerootForDiscovery("sources/feed", "structured")).toEqual({ id: "sources/feed", rerooted: false });
  });

  it("leaves root-level ids alone — the vault root is discovered", () => {
    expect(rerootForDiscovery("readme", "structured")).toEqual({ id: "readme", rerooted: false });
  });

  it("never re-roots in an obsidian vault, which discovers every folder", () => {
    expect(rerootForDiscovery("projects/plan", "obsidian")).toEqual({ id: "projects/plan", rerooted: false });
  });
});

describe("heldReviewNotice", () => {
  it("tells the agent a held document is not searchable until approved", () => {
    const msg = heldReviewNotice("nodes/x");
    expect(msg).toMatch(/pending review/);
    expect(msg).toMatch(/not searchable/);
    expect(msg).toMatch(/turn off review/);
  });
});
