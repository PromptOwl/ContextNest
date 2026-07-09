import { describe, it, expect } from "vitest";
import {
  denyAllGovernance,
  allowAllGovernance,
  requireRead,
  requireCommit,
  filterReadable,
} from "../rbac.js";
import { UnauthorizedActionError } from "../errors.js";
import type { GovernanceHooks, RbacHook } from "../types.js";

/**
 * Hook fixture modeling a small org:
 *   editor@acme.com — read + commit everywhere
 *   viewer@acme.com — read only
 *   stranger@evil.com — nothing
 * Optionally a per-document read denylist (e.g. nodes/secret) applied to
 * everyone except editors.
 */
function acmeHooks(opts: { secretDocs?: string[] } = {}): GovernanceHooks {
  const readers = ["editor@acme.com", "viewer@acme.com"];
  const editors = ["editor@acme.com"];
  const secrets = opts.secretDocs ?? [];
  return {
    isCzar: (actor) => editors.includes(actor),
    canIngest: (actor) => readers.includes(actor),
    isDocOwner: (actor) => editors.includes(actor),
    canRead: (actor, target) => {
      if (!readers.includes(actor)) return false;
      if (secrets.includes(target.documentId)) return editors.includes(actor);
      return true;
    },
    canCommit: (actor) => editors.includes(actor),
  };
}

describe("Governance seams — requireRead / requireCommit / filterReadable", () => {
  describe("backward compatibility: absent hooks or absent methods = allow", () => {
    it("requireRead resolves when no hooks are supplied", async () => {
      await expect(
        requireRead(undefined, "anyone", { documentId: "nodes/doc" }, "readDocument"),
      ).resolves.toBeUndefined();
    });

    it("requireCommit resolves when no hooks are supplied", async () => {
      await expect(
        requireCommit(
          undefined,
          "anyone",
          { documentId: "nodes/doc" },
          "publish",
          "publishDocument",
        ),
      ).resolves.toBeUndefined();
    });

    it("a plain RbacHook (no canRead/canCommit) is a valid GovernanceHooks and allows reads/commits", async () => {
      // This is the exact shape existing deployments inject today.
      const legacy: RbacHook = {
        isCzar: () => false,
        canIngest: () => true,
        isDocOwner: () => true,
      };
      const asGovernance: GovernanceHooks = legacy; // type-level compat proof
      await expect(
        requireRead(asGovernance, "viewer@acme.com", { documentId: "nodes/doc" }, "read"),
      ).resolves.toBeUndefined();
      await expect(
        requireCommit(
          asGovernance,
          "viewer@acme.com",
          { documentId: "nodes/doc" },
          "update",
          "writeDocument",
        ),
      ).resolves.toBeUndefined();
    });

    it("filterReadable is identity when no hooks are supplied", async () => {
      const nodes = [{ id: "nodes/a" }, { id: "nodes/b" }];
      expect(await filterReadable(undefined, "anyone", nodes)).toEqual(nodes);
    });
  });

  describe("user story: viewer can read, cannot commit", () => {
    const hooks = acmeHooks();

    it("viewer read of a normal doc resolves", async () => {
      await expect(
        requireRead(hooks, "viewer@acme.com", { documentId: "nodes/handbook" }, "read"),
      ).resolves.toBeUndefined();
    });

    it("viewer commit is denied with actor + action on the error", async () => {
      try {
        await requireCommit(
          hooks,
          "viewer@acme.com",
          { documentId: "nodes/handbook" },
          "update",
          "writeDocument",
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedActionError);
        const e = err as UnauthorizedActionError;
        expect(e.actor).toBe("viewer@acme.com");
        expect(e.action).toBe("writeDocument");
      }
    });

    it("editor can commit every operation kind", async () => {
      for (const op of ["create", "update", "delete", "publish", "stage_suggestion"] as const) {
        await expect(
          requireCommit(hooks, "editor@acme.com", { documentId: "nodes/x" }, op, "op"),
        ).resolves.toBeUndefined();
      }
    });

    it("stranger is denied reads", async () => {
      await expect(
        requireRead(hooks, "stranger@evil.com", { documentId: "nodes/handbook" }, "read"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });
  });

  describe("filterReadable — per-document silent filtering", () => {
    const hooks = acmeHooks({ secretDocs: ["nodes/secret"] });
    const nodes = [
      { id: "nodes/a" },
      { id: "nodes/secret" },
      { id: "nodes/b" },
    ];

    it("viewer sees non-secret docs only, order preserved", async () => {
      const visible = await filterReadable(hooks, "viewer@acme.com", nodes);
      expect(visible.map((n) => n.id)).toEqual(["nodes/a", "nodes/b"]);
    });

    it("editor sees everything", async () => {
      const visible = await filterReadable(hooks, "editor@acme.com", nodes);
      expect(visible.map((n) => n.id)).toEqual(["nodes/a", "nodes/secret", "nodes/b"]);
    });

    it("stranger sees nothing", async () => {
      expect(await filterReadable(hooks, "stranger@evil.com", nodes)).toEqual([]);
    });
  });

  describe("bundled defaults", () => {
    it("denyAllGovernance denies reads and commits (safe baseline)", async () => {
      await expect(
        requireRead(denyAllGovernance, "anyone", { documentId: "nodes/doc" }, "read"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
      await expect(
        requireCommit(denyAllGovernance, "anyone", { documentId: "d" }, "update", "w"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
      expect(await denyAllGovernance.isCzar("a", "z")).toBe(false);
    });

    it("allowAllGovernance allows everything (single-user local default)", async () => {
      await expect(
        requireRead(allowAllGovernance, "anyone", { documentId: "nodes/doc" }, "read"),
      ).resolves.toBeUndefined();
      await expect(
        requireCommit(allowAllGovernance, "anyone", { documentId: "d" }, "publish", "p"),
      ).resolves.toBeUndefined();
      expect(await allowAllGovernance.isCzar("a", "z")).toBe(true);
    });
  });

  describe("async hooks are awaited end-to-end", () => {
    const asyncHooks: GovernanceHooks = {
      isCzar: () => false,
      canIngest: () => true,
      isDocOwner: () => false,
      canRead: async (actor) => {
        await Promise.resolve();
        return actor === "viewer@acme.com";
      },
      canCommit: async (actor) => {
        await Promise.resolve();
        return actor === "editor@acme.com";
      },
    };

    it("awaits async canRead", async () => {
      await expect(
        requireRead(asyncHooks, "viewer@acme.com", { documentId: "d" }, "read"),
      ).resolves.toBeUndefined();
      await expect(
        requireRead(asyncHooks, "stranger@evil.com", { documentId: "d" }, "read"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });

    it("awaits async canCommit in filterReadable-style batch checks", async () => {
      const visible = await filterReadable(asyncHooks, "viewer@acme.com", [
        { id: "nodes/a" },
      ]);
      expect(visible.map((n) => n.id)).toEqual(["nodes/a"]);
    });
  });
});
