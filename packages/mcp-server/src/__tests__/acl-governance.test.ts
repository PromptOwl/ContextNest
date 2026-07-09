/**
 * Unit tests for frontmatter-carried access control (acl-governance.ts).
 *
 * These pin the per-query read policy an MCP-only, multi-principal agent relies
 * on: a document is public unless its `metadata.access` block restricts it, and
 * a restricted document admits a reader whose principal id is in `readers` OR
 * whose role is in `roles`. `makeAclGovernance` narrows a base bundle's reads
 * and never widens them.
 */

import { describe, it, expect } from "vitest";
import type { Frontmatter, GovernanceHooks } from "@promptowl/contextnest-engine";
import { allowAllGovernance } from "@promptowl/contextnest-engine";
import {
  parseAccessControl,
  isRestricted,
  aclAllows,
  makeAclGovernance,
  type AclDocSource,
} from "../acl-governance.js";

function fm(access?: unknown): Frontmatter {
  return {
    title: "Doc",
    ...(access !== undefined ? { metadata: { access } } : {}),
  };
}

/** A doc source that returns a fixed frontmatter for every id. */
function sourceReturning(frontmatter: Frontmatter): AclDocSource {
  return { readDocument: async () => ({ frontmatter }) };
}

describe("parseAccessControl", () => {
  it("returns null when there is no metadata or no access block", () => {
    expect(parseAccessControl(fm())).toBeNull();
    expect(parseAccessControl({ title: "x", metadata: { other: 1 } })).toBeNull();
  });

  it("returns null when the access block carries nothing enforceable", () => {
    expect(parseAccessControl(fm({}))).toBeNull();
  });

  it("parses visibility, readers and roles, dropping non-strings", () => {
    const acl = parseAccessControl(
      fm({ visibility: "private", readers: ["alice", 42, "bob"], roles: ["nurse"] }),
    );
    expect(acl).toEqual({ visibility: "private", readers: ["alice", "bob"], roles: ["nurse"] });
  });

  it("ignores an invalid visibility value", () => {
    const acl = parseAccessControl(fm({ visibility: "secret", roles: ["doctor"] }));
    expect(acl).toEqual({ visibility: undefined, readers: undefined, roles: ["doctor"] });
  });
});

describe("isRestricted", () => {
  it("treats absent, public, or empty ACLs as open", () => {
    expect(isRestricted(null)).toBe(false);
    expect(isRestricted({ visibility: "public", readers: ["x"] })).toBe(false);
    expect(isRestricted({})).toBe(false);
  });

  it("treats private, or any reader/role list, as restricted", () => {
    expect(isRestricted({ visibility: "private" })).toBe(true);
    expect(isRestricted({ readers: ["alice"] })).toBe(true);
    expect(isRestricted({ roles: ["nurse"] })).toBe(true);
  });
});

describe("aclAllows", () => {
  it("permits anyone to read an unrestricted document", () => {
    expect(aclAllows(null, undefined, undefined)).toBe(true);
    expect(aclAllows({ visibility: "public" }, "anyone", "any-role")).toBe(true);
  });

  it("permits a reader whose principal id is listed", () => {
    const acl = { readers: ["alice", "bob"] };
    expect(aclAllows(acl, "alice", undefined)).toBe(true);
    expect(aclAllows(acl, "carol", undefined)).toBe(false);
  });

  it("permits a reader whose role is listed", () => {
    const acl = { roles: ["nurse", "doctor"] };
    expect(aclAllows(acl, "carol", "doctor")).toBe(true);
    expect(aclAllows(acl, "carol", "janitor")).toBe(false);
  });

  it("denies everyone on a private document with no readers/roles", () => {
    expect(aclAllows({ visibility: "private" }, "alice", "nurse")).toBe(false);
  });
});

describe("makeAclGovernance", () => {
  const target = { documentId: "nodes/secret" };

  it("allows reads of public documents", async () => {
    const gov = makeAclGovernance(allowAllGovernance, sourceReturning(fm()), "alice", "nurse");
    expect(await gov.canRead!("alice", target)).toBe(true);
  });

  it("enforces the document ACL against the asking principal and role", async () => {
    const restricted = sourceReturning(fm({ readers: ["alice"], roles: ["doctor"] }));

    const asAlice = makeAclGovernance(allowAllGovernance, restricted, "alice");
    expect(await asAlice.canRead!("alice", target)).toBe(true);

    const asDoctor = makeAclGovernance(allowAllGovernance, restricted, "carol", "doctor");
    expect(await asDoctor.canRead!("carol", target)).toBe(true);

    const asStranger = makeAclGovernance(allowAllGovernance, restricted, "mallory", "janitor");
    expect(await asStranger.canRead!("mallory", target)).toBe(false);
  });

  it("never widens access: a base denial wins even on a public document", async () => {
    const denyReads: GovernanceHooks = { ...allowAllGovernance, canRead: () => false };
    const gov = makeAclGovernance(denyReads, sourceReturning(fm()), "alice", "nurse");
    expect(await gov.canRead!("alice", target)).toBe(false);
  });

  it("abstains (defers to the base allow) when the document cannot be loaded", async () => {
    const missing: AclDocSource = {
      readDocument: async () => {
        throw new Error("not found");
      },
    };
    const gov = makeAclGovernance(allowAllGovernance, missing, "alice", "nurse");
    expect(await gov.canRead!("alice", target)).toBe(true);
  });

  it("delegates non-read gates to the base bundle", async () => {
    const gov = makeAclGovernance(allowAllGovernance, sourceReturning(fm()), "alice");
    expect(await gov.isCzar("alice", "zone")).toBe(true);
    expect(await gov.canCommit!("alice", target, "update")).toBe(true);
  });
});
