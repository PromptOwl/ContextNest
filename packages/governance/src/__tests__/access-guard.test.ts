/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Access guard tests — read gating and list filtering, including the
 * public-reader approved-only path.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openGovernanceDb, type GovernanceDb } from "../db/client.js";
import { canReadNode, filterAccessible } from "../access-guard.js";
import { isPublicReader } from "../access.js";
import {
  addCollaborator,
  addSteward,
  setApprovedVersion,
  setNestOwner,
  setNestVisibility,
  setStewardshipEnabled,
} from "../admin.js";

const NEST = "nest-1";
const OWNER = "owner@acme.com";

let db: GovernanceDb;

beforeEach(() => {
  db = openGovernanceDb(":memory:");
  setNestOwner(db, NEST, OWNER);
});

describe("canReadNode", () => {
  it("open read when stewardship is disabled", () => {
    expect(canReadNode(db, NEST, "nodes/x", "stranger@evil.com")).toBe(true);
  });

  it("gates via canUserAccess when stewardship is enabled", () => {
    setStewardshipEnabled(db, NEST, true);
    addCollaborator(db, NEST, "viewer@acme.com", "read");
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/a",
      email: "scoped@acme.com",
      role: "viewer",
    });

    expect(canReadNode(db, NEST, "nodes/a", OWNER)).toBe(true);
    expect(canReadNode(db, NEST, "nodes/a", "viewer@acme.com")).toBe(true);
    expect(canReadNode(db, NEST, "nodes/a", "scoped@acme.com")).toBe(true);
    // A steward row also grants nest-level read (community semantics), so
    // the scoped steward can still READ other nodes — just not edit them.
    expect(canReadNode(db, NEST, "nodes/b", "scoped@acme.com")).toBe(true);
    expect(canReadNode(db, NEST, "nodes/a", "stranger@evil.com")).toBe(false);
  });

  it("public readers see only nodes with an approved version", () => {
    setNestVisibility(db, NEST, "public");
    setApprovedVersion(db, NEST, "nodes/approved", 2, OWNER);

    expect(isPublicReader(db, NEST, "anon@public.com")).toBe(true);
    expect(canReadNode(db, NEST, "nodes/approved", "anon@public.com")).toBe(
      true,
    );
    expect(canReadNode(db, NEST, "nodes/draft", "anon@public.com")).toBe(false);
  });

  it("owner, collaborators, and stewards are not public readers", () => {
    setNestVisibility(db, NEST, "public");
    addCollaborator(db, NEST, "viewer@acme.com", "read");
    addSteward(db, NEST, {
      scope: "nest",
      email: "steward@acme.com",
      role: "viewer",
    });

    expect(isPublicReader(db, NEST, OWNER)).toBe(false);
    expect(isPublicReader(db, NEST, "viewer@acme.com")).toBe(false);
    expect(isPublicReader(db, NEST, "steward@acme.com")).toBe(false);
    const access = { super_admins: ["root@acme.com"] };
    expect(isPublicReader(db, NEST, "root@acme.com", access)).toBe(false);
  });
});

describe("filterAccessible", () => {
  const nodes = [{ id: "nodes/a" }, { id: "nodes/b" }, { id: "nodes/c" }];

  it("returns everything when stewardship is off", () => {
    expect(filterAccessible(db, NEST, "stranger@evil.com", nodes)).toEqual(
      nodes,
    );
  });

  it("filters strangers out when stewardship is on", () => {
    setStewardshipEnabled(db, NEST, true);
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/b",
      email: "scoped@acme.com",
      role: "viewer",
    });

    // Steward rows grant nest-level read, so the scoped steward still sees
    // the full list (community semantics); strangers see nothing.
    expect(filterAccessible(db, NEST, "scoped@acme.com", nodes)).toEqual(
      nodes,
    );
    expect(filterAccessible(db, NEST, OWNER, nodes)).toEqual(nodes);
    expect(filterAccessible(db, NEST, "stranger@evil.com", nodes)).toEqual([]);
  });

  it("public readers get approved nodes only", () => {
    setNestVisibility(db, NEST, "public");
    setApprovedVersion(db, NEST, "nodes/c", 1, OWNER);
    expect(
      filterAccessible(db, NEST, "anon@public.com", nodes).map((n) => n.id),
    ).toEqual(["nodes/c"]);
  });
});
