import { describe, it, expect } from "vitest";
import {
  frontmatterSchema,
  suggestionMetaSchema,
  hashChainEventSchema,
  GOVERNANCE_TIERS,
  SUGGESTION_SOURCES,
  HASH_CHAIN_EVENT_TYPES,
  ZONE_ID_PATTERN,
} from "../schemas.js";
import {
  ZoneChallengeError,
  QuarantineError,
  UnauthorizedActionError,
  ChainBreakError,
  ContextNestError,
} from "../errors.js";
import type {
  Frontmatter,
  SuggestionMeta,
  HashChainEvent,
  PendingChange,
  ContextNode,
  RbacHook,
  GovernanceTier,
  SuggestionSource,
  HashChainEventType,
} from "../types.js";

const validHash =
  "sha256:" + "a".repeat(64);
const otherValidHash =
  "sha256:" + "b".repeat(64);

describe("Step 1 — governance shapes (spec-traced)", () => {
  describe("Frontmatter zone + governance (zone-classification-rbac-spec §2.1)", () => {
    it("accepts a frontmatter declaring zone and governance", () => {
      const result = frontmatterSchema.safeParse({
        title: "Sales Playbook",
        zone: "client-acme",
        governance: "primary",
      });
      expect(result.success).toBe(true);
    });

    it("accepts a frontmatter without zone/governance (backward compat)", () => {
      const result = frontmatterSchema.safeParse({ title: "Legacy doc" });
      expect(result.success).toBe(true);
    });

    it("rejects a zone with uppercase letters", () => {
      const result = frontmatterSchema.safeParse({
        title: "Bad zone",
        zone: "Client-ACME",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a zone starting with a digit", () => {
      const result = frontmatterSchema.safeParse({
        title: "Bad zone",
        zone: "1client",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown governance tier", () => {
      const result = frontmatterSchema.safeParse({
        title: "Bad tier",
        governance: "draft" as unknown as GovernanceTier,
      });
      expect(result.success).toBe(false);
    });

    it("ZONE_ID_PATTERN matches snake_case, kebab-case, and mixed alphanumerics", () => {
      expect(ZONE_ID_PATTERN.test("leadership")).toBe(true);
      expect(ZONE_ID_PATTERN.test("client-acme")).toBe(true);
      expect(ZONE_ID_PATTERN.test("client_acme")).toBe(true);
      expect(ZONE_ID_PATTERN.test("project-atlas-2")).toBe(true);
      expect(ZONE_ID_PATTERN.test("-leadership")).toBe(false);
      expect(ZONE_ID_PATTERN.test("Leadership")).toBe(false);
      expect(ZONE_ID_PATTERN.test("client acme")).toBe(false);
    });
  });

  describe("SuggestionMeta schema (bridge-function-spec Story 3.1)", () => {
    const baseMeta: SuggestionMeta = {
      suggestion_id: "s_2026-04-19T12:00:00Z_a1b2c3",
      document_id: "nodes/sales-playbook",
      zone: "client-acme",
      doc_tier: "primary",
      source: "out-of-band-edit",
      actor: "user:analyst-7",
      detected_at: "2026-04-19T12:00:00Z",
      target_hash: validHash,
      proposed_hash: otherValidHash,
      patch_path: "_suggestions/sales-playbook-2026-04-19-a1b2c3.patch",
    };

    it("accepts a fully-populated suggestion meta", () => {
      const result = suggestionMetaSchema.safeParse(baseMeta);
      expect(result.success).toBe(true);
    });

    it("accepts standard-tier suggestion (hootie-inbox-spec §4.2)", () => {
      const result = suggestionMetaSchema.safeParse({
        ...baseMeta,
        doc_tier: "standard",
      });
      expect(result.success).toBe(true);
    });

    it("accepts quarantine source (Story 1.3 revoked-user delta)", () => {
      const result = suggestionMetaSchema.safeParse({
        ...baseMeta,
        source: "quarantine",
        note: "Offline edit from revoked actor — Czar review required",
      });
      expect(result.success).toBe(true);
    });

    it("rejects an invalid target_hash format", () => {
      const result = suggestionMetaSchema.safeParse({
        ...baseMeta,
        target_hash: "not-a-sha256-hash",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unknown source", () => {
      const result = suggestionMetaSchema.safeParse({
        ...baseMeta,
        source: "ai-hallucinated" as unknown as SuggestionSource,
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty actor (audit trail must identify caller)", () => {
      const result = suggestionMetaSchema.safeParse({ ...baseMeta, actor: "" });
      expect(result.success).toBe(false);
    });

    it("rejects a zone with invalid characters", () => {
      const result = suggestionMetaSchema.safeParse({
        ...baseMeta,
        zone: "Client/ACME",
      });
      expect(result.success).toBe(false);
    });

    it("SUGGESTION_SOURCES enum covers spec sources only", () => {
      expect([...SUGGESTION_SOURCES].sort()).toEqual(
        ["out-of-band-edit", "remote-push", "manual-suggestion", "quarantine"].sort(),
      );
    });

    it("GOVERNANCE_TIERS enum covers spec tiers only", () => {
      expect([...GOVERNANCE_TIERS].sort()).toEqual(["primary", "standard"].sort());
    });
  });

  describe("HashChainEvent schema (zone-classification-rbac-spec §6)", () => {
    const baseEvent: HashChainEvent = {
      event_id: "evt_2026-04-19T12:00:00Z_xyz",
      event_type: "primary.approved",
      timestamp: "2026-04-19T12:00:00Z",
      actor: "czar:vp-strategy",
      zone: "leadership",
      document_id: "nodes/sales-playbook",
      resulting_hash: validHash,
      action_metadata: { suggestion_id: "s_001", approval_comment: "LGTM" },
      signature: "sig_placeholder",
    };

    it("accepts a fully-populated approval event", () => {
      const result = hashChainEventSchema.safeParse(baseEvent);
      expect(result.success).toBe(true);
    });

    it("accepts a permission grant event with self-grant flag", () => {
      const result = hashChainEventSchema.safeParse({
        ...baseEvent,
        event_type: "permission.self_granted",
        action_metadata: { granted_zone: "leadership", flagged: true },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a dream blocked cross-zone event (no resulting_hash)", () => {
      const { resulting_hash: _omit, ...withoutHash } = baseEvent;
      const result = hashChainEventSchema.safeParse({
        ...withoutHash,
        event_type: "dream.blocked_cross_zone",
        action_metadata: { attempted_zones: ["client-acme", "leadership"] },
      });
      expect(result.success).toBe(true);
    });

    it("rejects an unknown event_type", () => {
      const result = hashChainEventSchema.safeParse({
        ...baseEvent,
        event_type: "primary.silently_committed" as unknown as HashChainEventType,
      });
      expect(result.success).toBe(false);
    });

    it("rejects a malformed resulting_hash", () => {
      const result = hashChainEventSchema.safeParse({
        ...baseEvent,
        resulting_hash: "sha256:zzzz",
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty actor (every chain event must identify the actor)", () => {
      const result = hashChainEventSchema.safeParse({ ...baseEvent, actor: "" });
      expect(result.success).toBe(false);
    });

    it("HASH_CHAIN_EVENT_TYPES includes the full spec §6 + hootie §8 taxonomy", () => {
      // Spot-check critical event types from spec §6 and hootie §8.
      const required = [
        "primary.approved",
        "primary.rejected",
        "primary.force_pushed",
        "primary.force_push_acknowledged",
        "standard.owner_approved",
        "standard.owner_altered",
        "standard.owner_rolled_back",
        "dream.proposed",
        "dream.approved",
        "dream.rejected",
        "dream.blocked_cross_zone",
        "todo.delegated",
        "zone.created",
        "zone.deleted",
        "czar.appointed",
        "czar.removed",
        "czar.vacancy_declared",
        "permission.granted",
        "permission.revoked",
        "permission.self_granted",
        "zone_challenge.raised",
        "zone_challenge.resolved",
        "reclassification.approved",
        "reclassification.rejected",
        "bridge_document.created",
        "manifest.updated",
        "platform_admin.toggle_changed",
        "platform_admin.session_opened",
        "platform_admin.session_closed",
        "agent.zone_scope_assigned",
      ];
      for (const t of required) {
        expect(HASH_CHAIN_EVENT_TYPES).toContain(t);
      }
    });
  });

  describe("Errors (spec-traced)", () => {
    it("ZoneChallengeError carries doc and both zones (§2.4)", () => {
      const err = new ZoneChallengeError(
        "nodes/discovery",
        "public",
        "client-acme",
      );
      expect(err).toBeInstanceOf(ContextNestError);
      expect(err.code).toBe("ZONE_CHALLENGE");
      expect(err.specSection).toBe("§2.4");
      expect(err.name).toBe("ZoneChallengeError");
      expect(err.documentId).toBe("nodes/discovery");
      expect(err.declaredZone).toBe("public");
      expect(err.impliedZone).toBe("client-acme");
      expect(err.message).toContain("nodes/discovery");
    });

    it("QuarantineError carries doc and reason (Story 1.3)", () => {
      const err = new QuarantineError(
        "nodes/contractor-notes",
        "Actor access revoked",
      );
      expect(err.code).toBe("QUARANTINE");
      expect(err.specSection).toBe("Story 1.3");
      expect(err.name).toBe("QuarantineError");
      expect(err.documentId).toBe("nodes/contractor-notes");
      expect(err.reason).toBe("Actor access revoked");
    });

    it("UnauthorizedActionError carries actor + action + optional zone (§4)", () => {
      const err = new UnauthorizedActionError(
        "user:analyst-7",
        "approveSuggestion",
        "leadership",
      );
      expect(err.code).toBe("UNAUTHORIZED_ACTION");
      expect(err.specSection).toBe("§4");
      expect(err.name).toBe("UnauthorizedActionError");
      expect(err.actor).toBe("user:analyst-7");
      expect(err.action).toBe("approveSuggestion");
      expect(err.zone).toBe("leadership");
      expect(err.message).toContain("leadership");
    });

    it("UnauthorizedActionError omits zone phrase when zone not supplied", () => {
      const err = new UnauthorizedActionError("user:bot", "ingestRemoteDelta");
      expect(err.zone).toBeUndefined();
      expect(err.message).not.toContain("in zone");
    });

    it("ChainBreakError carries doc + expected and actual prev hash (§367)", () => {
      const err = new ChainBreakError(
        "nodes/policy",
        validHash,
        otherValidHash,
      );
      expect(err.code).toBe("CHAIN_BREAK");
      expect(err.specSection).toBe("§367");
      expect(err.name).toBe("ChainBreakError");
      expect(err.documentId).toBe("nodes/policy");
      expect(err.expectedPrevHash).toBe(validHash);
      expect(err.actualPrevHash).toBe(otherValidHash);
    });
  });

  describe("Type shape compile-checks (no runtime work)", () => {
    it("Frontmatter accepts zone/governance assignment", () => {
      const fm: Frontmatter = {
        title: "Doc",
        zone: "leadership",
        governance: "primary",
      };
      expect(fm.zone).toBe("leadership");
      expect(fm.governance).toBe("primary");
    });

    it("ContextNode accepts an optional pendingChange", () => {
      const pending: PendingChange = {
        suggestion_id: "s_1",
        detected_at: "2026-04-19T12:00:00Z",
        source: "out-of-band-edit",
        proposed_hash: validHash,
      };
      const node: ContextNode = {
        id: "nodes/doc",
        filePath: "/abs/nodes/doc.md",
        frontmatter: { title: "Doc" },
        body: "body",
        rawContent: "---\ntitle: Doc\n---\nbody",
        pendingChange: pending,
      };
      expect(node.pendingChange?.suggestion_id).toBe("s_1");
    });

    it("RbacHook interface accepts a synchronous default-deny implementation", async () => {
      const denyAll: RbacHook = {
        isCzar: () => false,
        canIngest: () => false,
        isDocOwner: () => false,
      };
      expect(await denyAll.isCzar("anyone", "anywhere")).toBe(false);
      expect(await denyAll.canIngest("anyone", "anywhere")).toBe(false);
      expect(await denyAll.isDocOwner("anyone", "any/doc")).toBe(false);
    });

    it("RbacHook interface accepts an async implementation", async () => {
      const asyncHook: RbacHook = {
        isCzar: async (actor, zone) =>
          actor === "czar:vp-strategy" && zone === "leadership",
        canIngest: async () => true,
        isDocOwner: async () => false,
      };
      expect(await asyncHook.isCzar("czar:vp-strategy", "leadership")).toBe(true);
      expect(await asyncHook.isCzar("user:other", "leadership")).toBe(false);
    });
  });
});
