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

  it("keeps role strings as authored (format-only) and drops rows without an email", () => {
    const cfg = parseStewards(
      "nest:\n  - email: a@b.com\n    role: superuser\n  - role: reviewer\n",
    );
    // Non-canonical roles are preserved (validating role names is the
    // consumer's enforcement job); the row with no email is dropped.
    expect(cfg.nest).toEqual([{ email: "a@b.com", role: "superuser" }]);
  });

  it("returns { version: 1 } for empty input", () => {
    expect(parseStewards("")).toEqual({ version: 1 });
    expect(parseStewards("# just a comment\n")).toEqual({ version: 1 });
  });

  it("tolerates the legacy comma-joined shorthand without throwing or dropping role", () => {
    // js-yaml rejects this shape; the lenient fallback must recover email + role.
    const cfg = parseStewards(
      "nest:\n  - email: lead@acme.com, role: admin, can_approve: true\n" +
        'tags:\n  "#policy":\n    - email: rev@acme.com, role: reviewer\n',
    );
    expect(cfg.nest).toEqual([{ email: "lead@acme.com", role: "admin" }]);
    expect(cfg.tags?.["#policy"]).toEqual([{ email: "rev@acme.com", role: "reviewer" }]);
  });

  it("never throws on malformed YAML (returns best-effort, not a 500)", () => {
    expect(() => parseStewards("nest:\n  - [unclosed\n  : : :")).not.toThrow();
    expect(parseStewards("::: not yaml :::")).toHaveProperty("version", 1);
  });

  it("lenient fallback handles 4-space sub-key indentation, not just 2-space", () => {
    // The comma-joined shorthand forces the lenient path; the sub-keys here are
    // nested with 4 spaces. A fixed 2-space match silently dropped these entries.
    const cfg = parseStewards(
      [
        "tags:",
        '    "#policy":',
        "        - email: rev@acme.com, role: reviewer", // comma-joined → forces fallback
        "documents:",
        "    nodes/spec:",
        "        - email: viewer@acme.com, role: viewer",
      ].join("\n"),
    );
    expect(cfg.tags?.["#policy"]).toEqual([{ email: "rev@acme.com", role: "reviewer" }]);
    expect(cfg.documents?.["nodes/spec"]).toEqual([
      { email: "viewer@acme.com", role: "viewer" },
    ]);
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

  it("omits keys whose entry list is empty (symmetric with parseStewards)", () => {
    // parseStewards never yields an empty-array group, so serialize must not
    // emit one either — otherwise this round-trips asymmetrically.
    const cfg: StewardsConfig = {
      version: 1,
      tags: { "#empty": [], "#policy": [{ email: "a@b.com", role: "editor" }] },
      documents: { "nodes/x": [] },
    };
    const out = serializeStewards(cfg);
    expect(out).not.toContain("#empty");
    expect(out).not.toContain("documents:");
    expect(out).toContain("#policy");
    // Round-trips to just the non-empty content.
    expect(parseStewards(out)).toEqual({
      version: 1,
      tags: { "#policy": [{ email: "a@b.com", role: "editor" }] },
    });
  });

  it("preserves a non-default version through round-trip", () => {
    const cfg: StewardsConfig = { version: 2, nest: [{ email: "a@b.com" }] };
    const out = serializeStewards(cfg);
    expect(out).toContain("version: 2");
    expect(parseStewards(out).version).toBe(2);
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
