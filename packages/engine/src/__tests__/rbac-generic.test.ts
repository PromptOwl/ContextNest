/**
 * Generic RBAC surface tests — canEdit / canApprove.
 *
 * Complements the zone-model rbac.test.ts. Covers:
 *   - requireEdit / requireApprove route through hook.canEdit / canApprove
 *   - missing methods are treated as deny (never silently allow)
 *   - hooks may wire only the surface they need
 */

import { describe, it, expect } from "vitest";
import {
  denyAllRbac,
  requireEdit,
  requireApprove,
  requireCzar,
  requireDocOwner,
  UnauthorizedActionError,
} from "../index.js";
import type { RbacHook } from "../index.js";

describe("generic RBAC surface", () => {
  it("denyAllRbac denies both generic gates", async () => {
    await expect(
      requireEdit(denyAllRbac, "anyone", "nodes/api", "submit"),
    ).rejects.toThrow(UnauthorizedActionError);
    await expect(
      requireApprove(denyAllRbac, "anyone", "nodes/api", "approve"),
    ).rejects.toThrow(UnauthorizedActionError);
  });

  it("requireEdit honors canEdit when wired", async () => {
    const hook: RbacHook = {
      canEdit: (_actor, docId) => docId === "nodes/api",
    };
    await expect(
      requireEdit(hook, "alice", "nodes/api", "submit"),
    ).resolves.toBeUndefined();
    await expect(
      requireEdit(hook, "alice", "nodes/other", "submit"),
    ).rejects.toThrow(UnauthorizedActionError);
  });

  it("requireApprove honors canApprove when wired", async () => {
    const hook: RbacHook = {
      canApprove: async (actor) => actor === "reviewer@example.com",
    };
    await expect(
      requireApprove(hook, "reviewer@example.com", "nodes/api", "approve"),
    ).resolves.toBeUndefined();
    await expect(
      requireApprove(hook, "anyone-else", "nodes/api", "approve"),
    ).rejects.toThrow(UnauthorizedActionError);
  });

  it("denies when the method is missing from the hook", async () => {
    const editorOnlyHook: RbacHook = {
      canEdit: () => true,
      // canApprove deliberately omitted
    };
    await expect(
      requireEdit(editorOnlyHook, "alice", "nodes/api", "submit"),
    ).resolves.toBeUndefined();
    await expect(
      requireApprove(editorOnlyHook, "alice", "nodes/api", "approve"),
    ).rejects.toThrow(UnauthorizedActionError);
  });

  it("zone-model helpers still deny when zone methods are missing", async () => {
    const genericOnlyHook: RbacHook = {
      canEdit: () => true,
      canApprove: () => true,
    };
    await expect(
      requireCzar(genericOnlyHook, "alice", "zone-1", "approve"),
    ).rejects.toThrow(UnauthorizedActionError);
    await expect(
      requireDocOwner(genericOnlyHook, "alice", "nodes/api", "rollback"),
    ).rejects.toThrow(UnauthorizedActionError);
  });

  it("a fully-wired hook serves both surfaces", async () => {
    const hook: RbacHook = {
      canEdit: () => true,
      canApprove: () => true,
      isCzar: () => true,
      canIngest: () => true,
      isDocOwner: () => true,
    };
    await expect(
      requireEdit(hook, "a", "doc", "submit"),
    ).resolves.toBeUndefined();
    await expect(
      requireApprove(hook, "a", "doc", "approve"),
    ).resolves.toBeUndefined();
    await expect(
      requireCzar(hook, "a", "zone", "approve"),
    ).resolves.toBeUndefined();
    await expect(
      requireDocOwner(hook, "a", "doc", "rollback"),
    ).resolves.toBeUndefined();
  });
});
