/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Stewardship service tests — role resolution (document > tag > nest),
 * effective-role union of collaborator + steward rows, and the permission
 * checks including separation of duties. Runs against an in-memory SQLite
 * database.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openGovernanceDb, type GovernanceDb } from "../db/client.js";
import {
  addCollaborator,
  addSteward,
  recordNodeVersion,
  setAllowSelfApprove,
  setNestOwner,
  setNodeTags,
} from "../admin.js";
import {
  canCreateInNest,
  canManageStewards,
  canUserAccess,
  canUserApprove,
  canUserEdit,
  createStewardRecord,
  getStewardsForUser,
  resolveStewardsForNode,
  resolveStewardsWithFallback,
  resolveUserRoles,
  syncFromConfig,
  updateSteward,
} from "../stewardship-service.js";
import { resolveNestPermission } from "../access.js";
import { ConflictError, ValidationError } from "../errors.js";

const NEST = "nest-1";
const OWNER = "owner@acme.com";

let db: GovernanceDb;

beforeEach(() => {
  db = openGovernanceDb(":memory:");
  setNestOwner(db, NEST, OWNER);
});

function stagePendingReview(nodeId: string, requestedBy: string): void {
  db.prepare(
    `INSERT INTO review_requests (id, nest_id, node_id, version, requested_by, status)
     VALUES (?, ?, ?, 1, ?, 'pending')`,
  ).run(randomUUID(), NEST, nodeId, requestedBy);
}

describe("steward resolution priority", () => {
  it("resolves document > tag > nest with correct priorities", () => {
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/spec",
      email: "doc@acme.com",
      role: "reviewer",
    });
    addSteward(db, NEST, {
      scope: "tag",
      tagName: "#Architecture",
      email: "tag@acme.com",
      role: "reviewer",
    });
    addSteward(db, NEST, {
      scope: "nest",
      email: "nest@acme.com",
      role: "reviewer",
    });
    setNodeTags(db, NEST, "nodes/spec", ["architecture"]);

    const resolved = resolveStewardsForNode(db, NEST, "nodes/spec");
    expect(resolved.map((r) => [r.steward.userEmail, r.priority])).toEqual([
      ["doc@acme.com", 1],
      ["tag@acme.com", 2],
      ["nest@acme.com", 3],
    ]);
    expect(resolved[0].source).toContain("document");
    expect(resolved[1].source).toContain("tag");
    expect(resolved[2].source).toBe("nest-level steward");
  });

  it("tag names are normalized (leading # stripped, lowercased)", () => {
    addSteward(db, NEST, {
      scope: "tag",
      tagName: "#ARCHITECTURE",
      email: "tag@acme.com",
      role: "reviewer",
    });
    setNodeTags(db, NEST, "nodes/spec", ["#Architecture"]);
    const resolved = resolveStewardsForNode(db, NEST, "nodes/spec");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].steward.tagName).toBe("architecture");
  });

  it("falls back to the nest owner when nothing resolves", () => {
    const result = resolveStewardsWithFallback(db, NEST, "nodes/orphan");
    expect(result.stewards).toEqual([]);
    expect(result.fallbackToOwner).toBe(true);
    expect(result.ownerEmail).toBe(OWNER);
  });
});

describe("resolveUserRoles", () => {
  it("merges collaborator and steward roles (union)", () => {
    addCollaborator(db, NEST, "jane@acme.com", "write");
    addSteward(db, NEST, {
      scope: "nest",
      email: "jane@acme.com",
      role: "reviewer",
    });
    const roles = resolveUserRoles(db, NEST, "jane@acme.com");
    expect(roles.sort()).toEqual(["editor", "reviewer"]);
  });

  it("owner resolves to owner; super admin to admin", () => {
    expect(resolveUserRoles(db, NEST, OWNER)).toContain("owner");
    const access = { super_admins: ["root@acme.com"] };
    expect(
      resolveUserRoles(db, NEST, "root@acme.com", { access }),
    ).toContain("admin");
  });

  it("scopes steward roles to the node when nodeId is given", () => {
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/a",
      email: "doc@acme.com",
      role: "editor",
    });
    // On the governed node: editor steward role + the steward-row read
    // fallback (nest-level viewer).
    expect(
      resolveUserRoles(db, NEST, "doc@acme.com", { nodeId: "nodes/a" }).sort(),
    ).toEqual(["editor", "viewer"]);
    // On unrelated nodes only the read fallback remains.
    expect(
      resolveUserRoles(db, NEST, "doc@acme.com", { nodeId: "nodes/other" }),
    ).toEqual(["viewer"]);
  });
});

describe("canUserEdit / canUserAccess", () => {
  it("owner and write collaborator can edit; read collaborator cannot", () => {
    addCollaborator(db, NEST, "editor@acme.com", "write");
    addCollaborator(db, NEST, "viewer@acme.com", "read");

    expect(canUserEdit(db, NEST, "nodes/x", OWNER).allowed).toBe(true);
    expect(canUserEdit(db, NEST, "nodes/x", "editor@acme.com").allowed).toBe(
      true,
    );
    expect(canUserEdit(db, NEST, "nodes/x", "viewer@acme.com").allowed).toBe(
      false,
    );
    expect(canUserEdit(db, NEST, "nodes/x", "stranger@evil.com").allowed).toBe(
      false,
    );
  });

  it("editor steward can edit only within scope", () => {
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/a",
      email: "scoped@acme.com",
      role: "editor",
    });
    expect(canUserEdit(db, NEST, "nodes/a", "scoped@acme.com").allowed).toBe(
      true,
    );
    expect(canUserEdit(db, NEST, "nodes/b", "scoped@acme.com").allowed).toBe(
      false,
    );
  });

  it("viewer steward gets access but not edit", () => {
    addSteward(db, NEST, {
      scope: "nest",
      email: "watcher@acme.com",
      role: "viewer",
    });
    expect(canUserAccess(db, NEST, "nodes/x", "watcher@acme.com").allowed).toBe(
      true,
    );
    expect(canUserEdit(db, NEST, "nodes/x", "watcher@acme.com").allowed).toBe(
      false,
    );
    expect(
      canUserAccess(db, NEST, "nodes/x", "stranger@evil.com").allowed,
    ).toBe(false);
  });
});

describe("canUserApprove — separation of duties", () => {
  const NODE = "nodes/spec";

  beforeEach(() => {
    addCollaborator(db, NEST, "dev@acme.com", "write");
    addSteward(db, NEST, {
      scope: "nest",
      email: "reviewer@acme.com",
      role: "reviewer",
    });
  });

  it("a reviewer can approve a teammate's submission", () => {
    stagePendingReview(NODE, "dev@acme.com");
    const result = canUserApprove(db, NEST, NODE, "reviewer@acme.com");
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("reviewer");
  });

  it("a reviewer cannot approve their own submission", () => {
    stagePendingReview(NODE, "reviewer@acme.com");
    const result = canUserApprove(db, NEST, NODE, "reviewer@acme.com");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("separation of duties");
  });

  it("SoD keys on the pending review requester over the version author", () => {
    recordNodeVersion(db, {
      nestId: NEST,
      nodeId: NODE,
      version: 1,
      contentHash: "abc",
      author: "reviewer@acme.com",
    });
    // A teammate submitted the reviewer's earlier edit — the reviewer may
    // still approve because they are not the requester.
    stagePendingReview(NODE, "dev@acme.com");
    expect(canUserApprove(db, NEST, NODE, "reviewer@acme.com").allowed).toBe(
      true,
    );
  });

  it("falls back to the version author when no pending review exists", () => {
    recordNodeVersion(db, {
      nestId: NEST,
      nodeId: NODE,
      version: 1,
      contentHash: "abc",
      author: "reviewer@acme.com",
    });
    expect(canUserApprove(db, NEST, NODE, "reviewer@acme.com").allowed).toBe(
      false,
    );
  });

  it("owner without a reviewer role cannot approve while self-approve is off", () => {
    stagePendingReview(NODE, "dev@acme.com");
    const result = canUserApprove(db, NEST, NODE, OWNER);
    expect(result.allowed).toBe(false);
    expect(result.role).toBe("owner");
  });

  it("owner can approve anything once self-approve is on", () => {
    setAllowSelfApprove(db, NEST, true);
    stagePendingReview(NODE, OWNER);
    const result = canUserApprove(db, NEST, NODE, OWNER);
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("owner");
  });

  it("editor collaborators have no approval rights", () => {
    stagePendingReview(NODE, "someone@acme.com");
    const result = canUserApprove(db, NEST, NODE, "dev@acme.com");
    expect(result.allowed).toBe(false);
    expect(result.role).toBe("editor");
  });
});

describe("canManageStewards / canCreateInNest", () => {
  it("owner and admin collaborators manage stewards; editors do not", () => {
    addCollaborator(db, NEST, "admin@acme.com", "admin");
    addCollaborator(db, NEST, "dev@acme.com", "write");
    expect(canManageStewards(db, NEST, OWNER)).toBe(true);
    expect(canManageStewards(db, NEST, "admin@acme.com")).toBe(true);
    expect(canManageStewards(db, NEST, "dev@acme.com")).toBe(false);
    expect(canManageStewards(db, NEST, "stranger@evil.com")).toBe(false);
  });

  it("super admins manage stewards on every nest", () => {
    const access = { super_admins: ["root@acme.com"] };
    expect(canManageStewards(db, NEST, "root@acme.com", { access })).toBe(
      true,
    );
  });

  it("create requires nest-wide write or a nest-scope editor steward", () => {
    addCollaborator(db, NEST, "dev@acme.com", "write");
    addCollaborator(db, NEST, "viewer@acme.com", "read");
    addSteward(db, NEST, {
      scope: "nest",
      email: "nesteditor@acme.com",
      role: "editor",
    });
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/a",
      email: "doceditor@acme.com",
      role: "editor",
    });

    expect(canCreateInNest(db, NEST, OWNER)).toBe(true);
    expect(canCreateInNest(db, NEST, "dev@acme.com")).toBe(true);
    expect(canCreateInNest(db, NEST, "nesteditor@acme.com")).toBe(true);
    // Document-scoped editor can't create new nest documents.
    expect(canCreateInNest(db, NEST, "doceditor@acme.com")).toBe(false);
    expect(canCreateInNest(db, NEST, "viewer@acme.com")).toBe(false);
    expect(canCreateInNest(db, NEST, "stranger@evil.com")).toBe(false);
  });
});

describe("createStewardRecord guards", () => {
  it("rejects adding the nest owner as a steward", () => {
    expect(() =>
      createStewardRecord(db, {
        nestId: NEST,
        scope: "nest",
        users: [{ email: OWNER }],
        assignedBy: "admin@acme.com",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects self-assignment by the roster manager", () => {
    expect(() =>
      createStewardRecord(db, {
        nestId: NEST,
        scope: "nest",
        users: [{ email: "admin@acme.com" }],
        assignedBy: "admin@acme.com",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a duplicate active row for the same scope+target", () => {
    createStewardRecord(db, {
      nestId: NEST,
      scope: "tag",
      tagName: "#api",
      users: [{ email: "jane@acme.com", role: "reviewer" }],
      assignedBy: "admin@acme.com",
    });
    expect(() =>
      createStewardRecord(db, {
        nestId: NEST,
        scope: "tag",
        tagName: "api",
        users: [{ email: "jane@acme.com", role: "editor" }],
        assignedBy: "admin@acme.com",
      }),
    ).toThrow(ConflictError);
  });

  it("flips the nest into governed mode", () => {
    createStewardRecord(db, {
      nestId: NEST,
      scope: "nest",
      users: [{ email: "jane@acme.com" }],
      assignedBy: "admin@acme.com",
    });
    const row = db
      .prepare("SELECT stewardship_enabled FROM nest_settings WHERE nest_id = ?")
      .get(NEST) as { stewardship_enabled: number };
    expect(row.stewardship_enabled).toBe(1);
  });
});

describe("updateSteward", () => {
  it("updates role in place and rejects invalid roles", () => {
    const [steward] = createStewardRecord(db, {
      nestId: NEST,
      scope: "nest",
      users: [{ email: "jane@acme.com", role: "viewer" }],
      assignedBy: "admin@acme.com",
    });
    const updated = updateSteward(db, steward.id, { role: "reviewer" });
    expect(updated.role).toBe("reviewer");
    expect(() =>
      updateSteward(db, steward.id, { role: "czar" as never }),
    ).toThrow(ValidationError);
  });

  it("re-scopes a steward and blocks collisions", () => {
    const [a] = createStewardRecord(db, {
      nestId: NEST,
      scope: "tag",
      tagName: "api",
      users: [{ email: "jane@acme.com", role: "reviewer" }],
      assignedBy: "admin@acme.com",
    });
    createStewardRecord(db, {
      nestId: NEST,
      scope: "document",
      documentId: "nodes/spec",
      users: [{ email: "jane@acme.com", role: "editor" }],
      assignedBy: "admin@acme.com",
    });

    // Re-scoping the tag row onto the document jane already stewards collides.
    expect(() =>
      updateSteward(db, a.id, { scope: "document", documentId: "nodes/spec" }),
    ).toThrow(ConflictError);

    const moved = updateSteward(db, a.id, {
      scope: "document",
      documentId: "nodes/other",
    });
    expect(moved.scope).toBe("document");
    expect(moved.nodePattern).toBe("nodes/other");
    expect(moved.tagName).toBeUndefined();
  });
});

describe("syncFromConfig", () => {
  it("replaces the roster from stewards.yaml shape and maps legacy admin role", () => {
    addSteward(db, NEST, {
      scope: "nest",
      email: "old@acme.com",
      role: "reviewer",
    });

    const count = syncFromConfig(db, NEST, {
      version: 1,
      nest: [{ email: "Lead@acme.com", role: "admin" as never }],
      tags: {
        "#Architecture": [{ email: "jane@acme.com", role: "reviewer" }],
      },
      documents: {
        "nodes/spec": [{ email: "doc@acme.com", role: "editor" }],
      },
    });
    expect(count).toBe(3);

    const active = getStewardsForUser(db, NEST, "old@acme.com");
    expect(active).toEqual([]);

    const lead = getStewardsForUser(db, NEST, "lead@acme.com");
    expect(lead).toHaveLength(1);
    // Legacy 'admin' role maps to 'reviewer'.
    expect(lead[0].role).toBe("reviewer");
    expect(lead[0].userEmail).toBe("lead@acme.com");

    setNodeTags(db, NEST, "nodes/design", ["architecture"]);
    const viaTag = resolveStewardsForNode(db, NEST, "nodes/design");
    expect(
      viaTag.some((r) => r.steward.userEmail === "jane@acme.com"),
    ).toBe(true);
  });
});

describe("resolveNestPermission integration", () => {
  it("stewards get nest-level read without a collaborator grant", () => {
    addSteward(db, NEST, {
      scope: "document",
      nodePattern: "nodes/a",
      email: "steward@acme.com",
      role: "reviewer",
    });
    expect(resolveNestPermission(db, NEST, "steward@acme.com")).toBe("read");
    expect(resolveNestPermission(db, NEST, "stranger@evil.com")).toBe("none");
    expect(resolveNestPermission(db, NEST, OWNER)).toBe("owner");
  });
});
