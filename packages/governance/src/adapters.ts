/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Governance adapter interfaces — the contract the governance layer is built
 * against. This package ships a SQLite (better-sqlite3) implementation; other
 * deployments (e.g. a Mongo-backed host) can implement the same interfaces to
 * plug into the governance system.
 */

import type {
  Steward,
  ResolvedSteward,
  ReviewRequest,
  ReviewRequestPriority,
  ReviewRequestStatus,
  DocumentLifecycleStatus,
  DocumentVersion,
  StewardshipScope,
  StewardsConfig,
  AccessConfig,
} from "./types.js";

/**
 * Stewardship storage — manage steward assignments and resolution.
 */
export interface StewardshipAdapter {
  // Steward CRUD
  assignSteward(data: Omit<Steward, "id">): Promise<Steward>;
  removeSteward(id: string): Promise<void>;
  getSteward(id: string): Promise<Steward | null>;

  // Queries
  getStewardsForNest(nestId: string): Promise<Steward[]>;
  getStewardsForScope(params: {
    nestId: string;
    scope?: StewardshipScope;
    scopeTarget?: string;
  }): Promise<Steward[]>;

  /**
   * Critical: resolve who governs a specific node. Tags are read from the
   * `node_tag_index` table — callers do not supply them.
   */
  resolveStewardsForNode(
    nestId: string,
    nodeId: string,
  ): Promise<ResolvedSteward[]>;

  /** Bulk sync from stewards.yaml. */
  syncFromConfig(nestId: string, config: StewardsConfig): Promise<number>;
}

/**
 * Review workflow — submit, approve, reject, queue.
 */
export interface ReviewAdapter {
  submitForReview(params: {
    nestId: string;
    nodeId: string;
    version: number;
    requestedBy: string;
    note?: string;
    priority?: ReviewRequestPriority;
  }): Promise<ReviewRequest>;

  approve(params: {
    nestId: string;
    nodeId: string;
    version: number;
    approvedBy: string;
    note?: string;
    override?: boolean;
  }): Promise<ReviewRequest>;

  reject(params: {
    nestId: string;
    nodeId: string;
    version: number;
    rejectedBy: string;
    note: string;
  }): Promise<ReviewRequest>;

  cancelReview(params: {
    nestId: string;
    nodeId: string;
    cancelledBy: string;
  }): Promise<ReviewRequest | null>;

  getReviewQueue(params: {
    nestId?: string;
    status?: ReviewRequestStatus | ReviewRequestStatus[];
    stewardEmail?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ requests: ReviewRequest[]; total: number }>;

  getReviewHistory(nestId: string, nodeId: string): Promise<ReviewRequest[]>;

  getPendingReview(
    nestId: string,
    nodeId: string,
  ): Promise<ReviewRequest | null>;
}

/**
 * Version storage — track node versions and conflict detection.
 */
export interface VersionAdapter {
  createVersion(params: {
    nestId: string;
    nodeId: string;
    version: number;
    contentHash: string;
    author: string;
    status: DocumentLifecycleStatus;
    changeNote?: string;
  }): Promise<DocumentVersion>;

  getVersions(nestId: string, nodeId: string): Promise<DocumentVersion[]>;

  getVersion(
    nestId: string,
    nodeId: string,
    version: number,
  ): Promise<DocumentVersion | null>;

  getCurrentVersion(nestId: string, nodeId: string): Promise<number>;

  /** Which version is approved (what AI queries serve), or null. */
  getApprovedVersion(nestId: string, nodeId: string): Promise<number | null>;

  setApprovedVersion(
    nestId: string,
    nodeId: string,
    version: number,
  ): Promise<void>;
}

/**
 * Access control — deployment-level config for allowed users, groups, super
 * admins (access.yaml).
 */
export interface AccessAdapter {
  loadConfig(configPath: string): AccessConfig;
  isEmailAllowed(email: string): boolean;
  getGroupsForUser(email: string): string[];
  getDefaultPermission(email: string): "read" | "write" | "admin" | null;
  isSuperAdmin(email: string): boolean;
}

/**
 * Permission checks — convenience functions built on top of the adapters.
 */
export interface PermissionChecker {
  canApprove(
    nestId: string,
    nodeId: string,
    userEmail: string,
  ): Promise<{ allowed: boolean; reason: string }>;

  canEdit(
    nestId: string,
    nodeId: string,
    userEmail: string,
  ): Promise<{ allowed: boolean; reason: string }>;

  canAccess(
    nestId: string,
    nodeId: string,
    userEmail: string,
  ): Promise<{
    allowed: boolean;
    role: "owner" | "editor" | "reviewer" | "viewer" | null;
    reason: string;
  }>;
}
