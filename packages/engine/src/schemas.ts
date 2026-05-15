/**
 * Zod validation schemas for Context Nest documents.
 * Covers validation rules 1–17 from §13.
 */

import { z } from "zod";

export const NODE_TYPES = [
  "document",
  "snippet",
  "glossary",
  "persona",
  "prompt",
  "source",
  "tool",
  "reference",
  "skill",
] as const;

export const STATUSES = ["draft", "published"] as const;

export const TRANSPORTS = ["mcp", "rest", "cli", "function"] as const;

/** Governance tier enum (zone-classification-rbac-spec §1) */
export const GOVERNANCE_TIERS = ["primary", "standard"] as const;

/** Suggestion source enum (bridge-function-spec Story 3.1, Story 1.3) */
export const SUGGESTION_SOURCES = [
  "out-of-band-edit",
  "remote-push",
  "manual-suggestion",
  "quarantine",
] as const;

/** Hash chain event taxonomy (zone-classification-rbac-spec §6, hootie-inbox-spec §8) */
export const HASH_CHAIN_EVENT_TYPES = [
  "primary.approved",
  "primary.rejected",
  "primary.rolled_back",
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
] as const;

/** Zone ID pattern: lowercase letter start, then alphanumeric / hyphen / underscore */
export const ZONE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Tag pattern: optional # prefix, then letter, then alphanumeric/underscore/hyphen (§13 rule 5) */
export const TAG_PATTERN = /^#?[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Checksum pattern (§13 rule 8) */
export const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** contextnest:// URI pattern */
export const CONTEXT_NEST_URI_PATTERN = /^contextnest:\/\//;

const tagSchema = z.string().regex(TAG_PATTERN, "Tag must match pattern: ^#?[a-zA-Z][a-zA-Z0-9_-]*$");

const skillInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "array", "object"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

const skillMetaSchema = z.object({
  trigger: z.string().min(1),
  inputs: z.array(skillInputSchema).optional(),
  tools_required: z.array(z.string()).optional(),
  output_format: z.enum(["markdown", "json", "text", "code"]).optional(),
  guard_rails: z.array(z.string()).optional(),
});

const sourceMetaSchema = z.object({
  transport: z.enum(TRANSPORTS),          // Rule 10
  server: z.string().optional(),           // Rule 12
  tools: z.array(z.string()).min(1),       // Rule 11
  depends_on: z
    .array(
      z.string().regex(CONTEXT_NEST_URI_PATTERN, "depends_on entries must be valid contextnest:// URIs"), // Rule 13
    )
    .optional(),
  cache_ttl: z.number().int().positive().optional(), // Rule 16
});

export const frontmatterSchema = z
  .object({
    title: z.string().min(1).max(200),                    // Rule 2
    description: z.string().min(1).max(500).optional(),
    type: z.enum(NODE_TYPES).optional(),                   // Rule 6
    tags: z.array(tagSchema).optional(),                   // Rule 5
    status: z.enum(STATUSES).optional(),                   // Rule 7
    version: z.number().int().min(1).optional(),
    author: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    derived_from: z.array(z.string()).optional(),
    checksum: z.string().regex(CHECKSUM_PATTERN, "Checksum must match sha256:<64 hex chars>").optional(), // Rule 8
    metadata: z.record(z.unknown()).optional(),
    source: sourceMetaSchema.optional(),
    skill: skillMetaSchema.optional(),
    zone: z
      .string()
      .regex(ZONE_ID_PATTERN, "Zone ID must match ^[a-z][a-z0-9_-]*$")
      .optional(),
    governance: z.enum(GOVERNANCE_TIERS).optional(),
  })
  .superRefine((data, ctx) => {
    // Rule 9: source block MUST be present when type is "source"
    if (data.type === "source" && !data.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source block is required when type is 'source' (§13 rule 9)",
        path: ["source"],
      });
    }
    // Rule 17: source block MUST NOT be present on non-source types
    if (data.type && data.type !== "source" && data.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source block must not be present when type is not 'source' (§13 rule 17)",
        path: ["source"],
      });
    }
    // Rule 18: skill block MUST be present when type is "skill"
    if (data.type === "skill" && !data.skill) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Skill block is required when type is 'skill' (§1.10)",
        path: ["skill"],
      });
    }
    // Rule 19: skill block MUST NOT be present on non-skill types
    if (data.type && data.type !== "skill" && data.skill) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Skill block must not be present when type is not 'skill'",
        path: ["skill"],
      });
    }
  });

export const nestConfigSchema = z.object({
  version: z.number().int(),
  name: z.string(),
  description: z.string().optional(),
  defaults: z
    .object({
      status: z.enum(STATUSES).optional(),
    })
    .optional(),
  folders: z
    .record(
      z.object({
        description: z.string().optional(),
        template: z.string().optional(),
      }),
    )
    .optional(),
  servers: z
    .record(
      z.object({
        url: z.string(),
        transport: z.enum(TRANSPORTS),
        description: z.string().optional(),
      }),
    )
    .optional(),
  sync: z
    .object({
      promptowl_data_room_id: z.string().optional(),
      auto_index: z.boolean().optional(),
    })
    .optional(),
  agent_maintenance_directive: z.string().optional(),
});

export const packSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  query: z.string().optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
  filters: z
    .object({
      node_types: z.array(z.enum(NODE_TYPES)).optional(),
    })
    .optional(),
  agent_instructions: z.string().optional(),
  audiences: z.array(z.string()).optional(),
});

export const versionEntrySchema = z.object({
  version: z.number().int().min(1),
  keyframe: z.boolean().optional(),
  diff: z.string().optional(),
  edited_by: z.string(),
  edited_at: z.string(),
  published_at: z.string().optional(),
  note: z.string().optional(),
  content_hash: z.string().regex(CHECKSUM_PATTERN),
  chain_hash: z.string().regex(CHECKSUM_PATTERN),
});

export const documentHistorySchema = z.object({
  keyframe_interval: z.number().int().min(1).default(10),
  versions: z.array(versionEntrySchema),
});

export const checkpointSchema = z.object({
  checkpoint: z.number().int().min(1),
  at: z.string(),
  triggered_by: z.string(),
  document_versions: z.record(z.number().int()),
  document_chain_hashes: z.record(z.string()),
  checkpoint_hash: z.string().regex(CHECKSUM_PATTERN),
});

export const checkpointHistorySchema = z.object({
  checkpoints: z.array(checkpointSchema),
});

/**
 * Suggestion metadata schema — persisted in `_suggestions/{doc}-...meta.yaml`
 * alongside the patch file. One per staged drift (bridge-function-spec
 * Story 3.1, hootie-inbox-spec §4.1).
 */
export const suggestionMetaSchema = z.object({
  suggestion_id: z.string().min(1),
  document_id: z.string().min(1),
  zone: z
    .string()
    .regex(ZONE_ID_PATTERN, "Zone ID must match ^[a-z][a-z0-9_-]*$")
    .optional(),
  doc_tier: z.enum(GOVERNANCE_TIERS),
  source: z.enum(SUGGESTION_SOURCES),
  actor: z.string().min(1),
  detected_at: z.string().min(1),
  target_hash: z.string().regex(CHECKSUM_PATTERN),
  proposed_hash: z.string().regex(CHECKSUM_PATTERN),
  patch_path: z.string().min(1),
  note: z.string().optional(),
});

/**
 * Hash chain event schema — every governance action emits one of these
 * (zone-classification-rbac-spec §6, hootie-inbox-spec §8). Events are
 * immutable; the chain is append-only.
 */
export const hashChainEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.enum(HASH_CHAIN_EVENT_TYPES),
  timestamp: z.string().min(1),
  actor: z.string().min(1),
  zone: z
    .string()
    .regex(ZONE_ID_PATTERN, "Zone ID must match ^[a-z][a-z0-9_-]*$")
    .optional(),
  document_id: z.string().optional(),
  resulting_hash: z.string().regex(CHECKSUM_PATTERN).optional(),
  action_metadata: z.record(z.unknown()).optional(),
  signature: z.string().optional(),
});

export type FrontmatterInput = z.input<typeof frontmatterSchema>;
export type NestConfigInput = z.input<typeof nestConfigSchema>;
export type PackInput = z.input<typeof packSchema>;
export type SuggestionMetaInput = z.input<typeof suggestionMetaSchema>;
export type HashChainEventInput = z.input<typeof hashChainEventSchema>;
