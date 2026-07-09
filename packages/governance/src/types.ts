/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Governance types — ported from the ContextNest community server's
 * governance layer, decoupled from its HTTP/auth stack. Identity here is a
 * plain email string (the engine actor IS the email); there is no users
 * table in this package.
 */

/**
 * Document lifecycle states. `published` is the terminal state for
 * auto-publish (no-stewards) saves; `approved` is kept for the stewards
 * approval workflow and legacy data.
 */
export type DocumentLifecycleStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "published"
  | "rejected";

/** Stewardship scope types (resolution priority: document > tag > nest). */
export type StewardshipScope = "document" | "tag" | "nest";

/** Review request priority levels. */
export type ReviewRequestPriority = "low" | "normal" | "high" | "urgent";

/** Review request status. */
export type ReviewRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled";

/**
 * Steward role. Semantics: viewer -> access only, editor -> edit,
 * reviewer -> approve+reject+access.
 */
export type StewardRole = "editor" | "reviewer" | "viewer";

/** One recorded node version (metadata; content lives with the engine vault). */
export interface DocumentVersion {
  version: number;
  contentHash: string;
  author: string;
  createdAt: string;
  changeNote?: string;
  status: DocumentLifecycleStatus;
}

/** Steward assignment. */
export interface Steward {
  id: string;
  nestId: string;
  scope: StewardshipScope;
  /** Exact node id for document scope. */
  nodePattern?: string;
  /** Tag name (no leading `#`, lowercased) for tag scope. */
  tagName?: string;
  /** Assignee — email is the identity in this package. */
  userEmail: string;
  role: StewardRole;
  assignedBy: string;
  assignedAt: string;
  isActive: boolean;
}

/** Resolved steward with priority (returned from resolution). */
export interface ResolvedSteward {
  steward: Steward;
  /** 1=document, 2=tag, 3=nest. */
  priority: number;
  /** Human-readable reason (e.g. `tag: architecture`). */
  source: string;
}

/** Review request. */
export interface ReviewRequest {
  id: string;
  nestId: string;
  nodeId: string;
  version: number;
  /** Email. */
  requestedBy: string;
  requestedAt: string;
  requestNote?: string;
  status: ReviewRequestStatus;
  /** Email. */
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  priority: ReviewRequestPriority;
}

/**
 * One entry in the per-node / per-nest activity log. Aggregates "who did
 * what" across edits and reviews — read-only, derived from the actor and
 * timestamp fields on each source table.
 */
export type ActivityType =
  | "edit"
  | "review_requested"
  | "review_resolved";

export interface ActivityEntry {
  type: ActivityType;
  nodeId: string;
  /** Email of who did it. */
  actor: string;
  /** ISO-ish timestamp. */
  at: string;
  /** e.g. "approved v4", change note. */
  detail?: string;
  /** Id of the source row (review id, version no.). */
  refId?: string;
}

/** stewards.yaml format. */
export interface StewardsConfig {
  version: number;
  nest?: StewardEntry[];
  tags?: Record<string, StewardEntry[]>;
  documents?: Record<string, StewardEntry[]>;
}

export interface StewardEntry {
  email: string;
  role?: StewardRole;
}

/** access.yaml format (deployment-level config). */
export interface AccessConfig {
  mode?: "open" | "restricted";
  /** Email list; supports wildcards like `*.acme.com`. */
  allowed_users?: string[];
  groups?: Record<
    string,
    {
      members: string[];
      default_permission: "read" | "write" | "admin";
    }
  >;
  super_admins?: string[];
}

/** Nest-wide collaborator grant (email-keyed — no users table). */
export interface Collaborator {
  id: string;
  nestId: string;
  userEmail: string;
  permission: "read" | "write" | "admin";
  grantedBy: string;
  grantedAt: string;
}

/**
 * Per-nest governance settings. Replaces the community server's `nests`
 * table columns (owner, visibility, stewardship toggle, self-approve
 * bypass) — this package has no nest CRUD, only governance state.
 */
export interface NestSettings {
  nestId: string;
  /** The nest owner's email; implicit full edit + manage rights. */
  ownerEmail: string | null;
  visibility: "private" | "public";
  /** Off = ungoverned (open reads, auto-approved writes for editors). */
  stewardshipEnabled: boolean;
  /** On = the owner/super-admin may approve their own submissions. */
  allowSelfApprove: boolean;
}
