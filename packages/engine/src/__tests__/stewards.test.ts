import { describe, it, expect } from "vitest";
import {
  parseStewards,
  serializeStewards,
  STEWARDS_FILENAMES,
  type StewardsConfig,
} from "../stewards.js";

/**
 * Seam #1 — canonical stewards.yaml parse/serialize. Replaces the hand-rolled
 * ports in the community server (`stewards-parser.ts`) and TheOwl
 * (`deserializeStewards`). Format only; enforcement stays with the consumer.
 */
describe("parseStewards", () => {
  it("parses nest / tags / documents with roles", () => {
    const cfg = parseStewards(
      [
        "version: 1",
        "nest:",
        "  - email: owner@x.com",
        "    role: reviewer",
        "tags:",
        '  "#policy":',
        "    - { email: editor@x.com, role: editor }",
        "documents:",
        "  nodes/spec:",
        "    - email: viewer@x.com",
        "      role: viewer",
      ].join("\n"),
    );
    expect(cfg.version).toBe(1);
    expect(cfg.nest).toEqual([{ email: "owner@x.com", role: "reviewer" }]);
    expect(cfg.tags?.["#policy"]).toEqual([{ email: "editor@x.com", role: "editor" }]);
    expect(cfg.documents?.["nodes/spec"]).toEqual([{ email: "viewer@x.com", role: "viewer" }]);
  });

  it("accepts an email-only entry (no role)", () => {
    const cfg = parseStewards("nest:\n  - email: a@b.com\n");
    expect(cfg.nest).toEqual([{ email: "a@b.com" }]);
  });

  it("treats data_room as a legacy alias for nest and ignores folders + legacy role keys", () => {
    const cfg = parseStewards(
      [
        "data_room:",
        "  - email: a@b.com",
        "    role: reviewer",
        "    can_approve: true", // legacy — ignored
        "folders:", // legacy scope — ignored entirely
        "  some/folder:",
        "    - email: nope@x.com",
      ].join("\n"),
    );
    expect(cfg.nest).toEqual([{ email: "a@b.com", role: "reviewer" }]);
    expect(cfg.documents).toBeUndefined();
    // folders is not a supported group, so nothing leaks into tags/documents
    expect(cfg.tags).toBeUndefined();
  });

  it("drops invalid role values and rows without an email", () => {
    const cfg = parseStewards(
      "nest:\n  - email: a@b.com\n    role: superuser\n  - role: reviewer\n",
    );
    expect(cfg.nest).toEqual([{ email: "a@b.com" }]);
  });

  it("returns { version: 1 } for empty input", () => {
    expect(parseStewards("")).toEqual({ version: 1 });
    expect(parseStewards("# just a comment\n")).toEqual({ version: 1 });
  });
});

describe("serializeStewards", () => {
  it("round-trips through parseStewards", () => {
    const cfg: StewardsConfig = {
      version: 1,
      nest: [{ email: "owner@x.com", role: "reviewer" }],
      tags: { "#policy": [{ email: "editor@x.com", role: "editor" }] },
      documents: { "nodes/spec": [{ email: "viewer@x.com" }] },
    };
    expect(parseStewards(serializeStewards(cfg))).toEqual(cfg);
  });

  it("quotes the '#'-prefixed tag key so it round-trips (not a YAML comment)", () => {
    const cfg: StewardsConfig = {
      version: 1,
      tags: { "#policy": [{ email: "a@b.com", role: "editor" }] },
    };
    const out = serializeStewards(cfg);
    expect(out).toMatch(/["']#policy["']/);
    expect(parseStewards(out).tags?.["#policy"]).toEqual([{ email: "a@b.com", role: "editor" }]);
  });

  it("omits empty groups", () => {
    const out = serializeStewards({ version: 1, nest: [], tags: {}, documents: {} });
    expect(out).not.toContain("nest:");
    expect(out).not.toContain("tags:");
    expect(out).toContain("version: 1");
  });
});

describe("STEWARDS_FILENAMES", () => {
  it("exposes the canonical lookup locations in precedence order", () => {
    expect(STEWARDS_FILENAMES).toEqual([
      "stewards.yaml",
      "stewards.yml",
      ".context/stewards.yaml",
    ]);
  });
});
