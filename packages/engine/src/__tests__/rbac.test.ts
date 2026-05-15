import { describe, it, expect } from "vitest";
import {
  denyAllRbac,
  requireCzar,
  requireIngest,
  requireDocOwner,
  filterIngestibleZones,
} from "../rbac.js";
import { UnauthorizedActionError } from "../errors.js";
import type { RbacHook } from "../types.js";

/** Hook fixture: explicit per-actor + per-zone tables for deterministic tests. */
function makeHook(opts: {
  czars?: Record<string, string[]>; // zoneId -> czar actors
  ingestors?: Record<string, string[]>; // zoneId -> actors with ingest
  owners?: Record<string, string[]>; // docId -> owner actors
}): RbacHook {
  return {
    isCzar: (actor, zoneId) =>
      (opts.czars?.[zoneId] ?? []).includes(actor),
    canIngest: (actor, zoneId) =>
      (opts.ingestors?.[zoneId] ?? []).includes(actor),
    isDocOwner: (actor, documentId) =>
      (opts.owners?.[documentId] ?? []).includes(actor),
  };
}

describe("RBAC — engine identity-agnostic enforcement", () => {
  describe("denyAllRbac (safe default, zone-classification-rbac-spec §4)", () => {
    it("denies isCzar for every actor + zone", async () => {
      expect(await denyAllRbac.isCzar("czar:vp", "leadership")).toBe(false);
      expect(await denyAllRbac.isCzar("anyone", "anywhere")).toBe(false);
    });

    it("denies canIngest for every actor + zone", async () => {
      expect(await denyAllRbac.canIngest("user:7", "client-acme")).toBe(false);
    });

    it("denies isDocOwner for every actor + doc", async () => {
      expect(await denyAllRbac.isDocOwner("user:7", "nodes/doc")).toBe(false);
    });

    it("blocks every requireCzar call when used as default", async () => {
      await expect(
        requireCzar(denyAllRbac, "anyone", "anywhere", "approveSuggestion"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });
  });

  describe("requireCzar (§5.4 Czar authorities)", () => {
    const hook = makeHook({
      czars: { leadership: ["czar:vp-strategy"], "client-acme": ["czar:acm"] },
    });

    it("resolves silently when actor is the Czar of the zone", async () => {
      await expect(
        requireCzar(hook, "czar:vp-strategy", "leadership", "approveDream"),
      ).resolves.toBeUndefined();
    });

    it("throws UnauthorizedActionError when actor is not the Czar", async () => {
      await expect(
        requireCzar(hook, "user:analyst-7", "leadership", "approveDream"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });

    it("error carries actor, action, and zone for audit", async () => {
      try {
        await requireCzar(
          hook,
          "user:analyst-7",
          "leadership",
          "approveDream",
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedActionError);
        const e = err as UnauthorizedActionError;
        expect(e.actor).toBe("user:analyst-7");
        expect(e.action).toBe("approveDream");
        expect(e.zone).toBe("leadership");
      }
    });

    it("treats each zone as an independent check (Czar of A is not Czar of B)", async () => {
      // czar:acm is Czar of client-acme but NOT leadership
      await expect(
        requireCzar(hook, "czar:acm", "client-acme", "approve"),
      ).resolves.toBeUndefined();
      await expect(
        requireCzar(hook, "czar:acm", "leadership", "approve"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });
  });

  describe("requireIngest (§4.1 single binary permission)", () => {
    const hook = makeHook({
      ingestors: {
        leadership: ["czar:vp", "user:exec"],
        "client-acme": ["user:rep-1"],
      },
    });

    it("resolves silently when actor has ingest for the zone", async () => {
      await expect(
        requireIngest(hook, "user:exec", "leadership", "readDocument"),
      ).resolves.toBeUndefined();
    });

    it("throws UnauthorizedActionError when actor lacks ingest", async () => {
      await expect(
        requireIngest(hook, "user:rep-1", "leadership", "readDocument"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });

    it("Story 6.2: blocks read of a Leadership doc from an Analyst without ingest", async () => {
      // Analyst has no ingest for `leadership`. Engine must refuse.
      await expect(
        requireIngest(hook, "user:analyst-7", "leadership", "pinSkillContext"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });
  });

  describe("requireDocOwner (hootie-inbox-spec §4.2)", () => {
    const hook = makeHook({
      owners: { "nodes/sales-playbook": ["user:rep-1"] },
    });

    it("resolves when actor owns the document", async () => {
      await expect(
        requireDocOwner(hook, "user:rep-1", "nodes/sales-playbook", "approve"),
      ).resolves.toBeUndefined();
    });

    it("throws when actor does not own the document", async () => {
      await expect(
        requireDocOwner(hook, "user:other", "nodes/sales-playbook", "rollback"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });

    it("error omits zone phrase (doc-owner check is zone-agnostic)", async () => {
      try {
        await requireDocOwner(
          hook,
          "user:other",
          "nodes/sales-playbook",
          "approve",
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedActionError);
        const e = err as UnauthorizedActionError;
        expect(e.zone).toBeUndefined();
        expect(e.message).not.toContain("in zone");
      }
    });
  });

  describe("filterIngestibleZones (Story 4.2 negative test)", () => {
    const hook = makeHook({
      ingestors: {
        leadership: ["user:exec"],
        "client-acme": ["user:exec", "user:rep-1"],
        "client-medtech": ["user:rep-2"],
      },
    });

    it("returns only zones the actor can ingest", async () => {
      const allowed = await filterIngestibleZones(hook, "user:exec", [
        "leadership",
        "client-acme",
        "client-medtech",
      ]);
      expect(allowed.sort()).toEqual(["client-acme", "leadership"].sort());
    });

    it("returns empty array when actor has no ingest anywhere (§3.2 isolation)", async () => {
      const allowed = await filterIngestibleZones(hook, "user:stranger", [
        "leadership",
        "client-acme",
        "client-medtech",
      ]);
      expect(allowed).toEqual([]);
    });

    it("hygienist scanner: filter strips zones before traversal (Story 4.2)", async () => {
      // Scanner running as user:rep-1 walks the vault. Zones from frontmatter
      // are filtered so cross-zone overlap detection never sees leadership.
      const vaultZones = [
        "leadership",
        "client-acme",
        "client-medtech",
        "public",
      ];
      const scannable = await filterIngestibleZones(
        hook,
        "user:rep-1",
        vaultZones,
      );
      expect(scannable).toEqual(["client-acme"]);
      expect(scannable).not.toContain("leadership");
      expect(scannable).not.toContain("client-medtech");
    });

    it("preserves input order for the allowed subset", async () => {
      const allowed = await filterIngestibleZones(hook, "user:exec", [
        "client-acme",
        "leadership",
      ]);
      expect(allowed).toEqual(["client-acme", "leadership"]);
    });
  });

  describe("Async hooks are awaited end-to-end", () => {
    const asyncHook: RbacHook = {
      isCzar: async (actor, zoneId) => {
        await Promise.resolve();
        return actor === "czar:async" && zoneId === "leadership";
      },
      canIngest: async (actor, zoneId) => {
        await Promise.resolve();
        return actor === "user:async" && zoneId === "client-acme";
      },
      isDocOwner: async () => {
        await Promise.resolve();
        return false;
      },
    };

    it("awaits async isCzar", async () => {
      await expect(
        requireCzar(asyncHook, "czar:async", "leadership", "approve"),
      ).resolves.toBeUndefined();
      await expect(
        requireCzar(asyncHook, "czar:wrong", "leadership", "approve"),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    });

    it("awaits async canIngest in filterIngestibleZones", async () => {
      const allowed = await filterIngestibleZones(asyncHook, "user:async", [
        "leadership",
        "client-acme",
        "public",
      ]);
      expect(allowed).toEqual(["client-acme"]);
    });
  });
});
