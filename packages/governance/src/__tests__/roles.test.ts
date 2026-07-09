/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

import { describe, it, expect } from "vitest";
import {
  collabPermToRole,
  canViewWith,
  canEditWith,
  canApproveWith,
  primaryRole,
  type EffectiveRole,
} from "../roles.js";

describe("collabPermToRole", () => {
  it("maps collaborator permissions to effective roles", () => {
    expect(collabPermToRole("owner")).toBe("owner");
    expect(collabPermToRole("admin")).toBe("admin");
    expect(collabPermToRole("write")).toBe("editor");
    expect(collabPermToRole("read")).toBe("viewer");
  });

  it("maps unknown/absent permissions to null", () => {
    expect(collabPermToRole("none")).toBeNull();
    expect(collabPermToRole(null)).toBeNull();
    expect(collabPermToRole(undefined)).toBeNull();
    expect(collabPermToRole("bogus")).toBeNull();
  });
});

describe("capability rules", () => {
  it("canViewWith: any role grants view; empty grants nothing", () => {
    expect(canViewWith(["viewer"])).toBe(true);
    expect(canViewWith(["reviewer"])).toBe(true);
    expect(canViewWith([])).toBe(false);
  });

  it("canEditWith: owner | admin | editor", () => {
    expect(canEditWith(["owner"])).toBe(true);
    expect(canEditWith(["admin"])).toBe(true);
    expect(canEditWith(["editor"])).toBe(true);
    expect(canEditWith(["reviewer"])).toBe(false);
    expect(canEditWith(["viewer"])).toBe(false);
    expect(canEditWith([])).toBe(false);
  });

  it("canApproveWith: owner | admin | reviewer", () => {
    expect(canApproveWith(["owner"])).toBe(true);
    expect(canApproveWith(["admin"])).toBe(true);
    expect(canApproveWith(["reviewer"])).toBe(true);
    expect(canApproveWith(["editor"])).toBe(false);
    expect(canApproveWith(["viewer"])).toBe(false);
  });

  it("union semantics: an editor+reviewer can both edit and approve", () => {
    const roles: EffectiveRole[] = ["editor", "reviewer"];
    expect(canEditWith(roles)).toBe(true);
    expect(canApproveWith(roles)).toBe(true);
  });
});

describe("primaryRole", () => {
  it("returns the highest-privilege role", () => {
    expect(primaryRole(["viewer", "owner", "editor"])).toBe("owner");
    expect(primaryRole(["reviewer", "editor"])).toBe("editor");
    expect(primaryRole(["viewer", "reviewer"])).toBe("reviewer");
    expect(primaryRole(["viewer"])).toBe("viewer");
  });

  it("returns null for no roles", () => {
    expect(primaryRole([])).toBeNull();
  });
});
