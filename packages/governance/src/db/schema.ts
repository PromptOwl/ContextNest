/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Governance schema — SQLite only (better-sqlite3).
 *
 * Ported from the community server's migrations, collapsed to the FINAL
 * table shapes (this package starts fresh — no migration history to
 * replay). Only the governance-relevant tables are kept:
 *
 *   - nest_settings       — per-nest governance state (replaces the server's
 *                           `nests` table columns: owner, visibility,
 *                           stewardship_enabled, allow_self_approve)
 *   - nest_collaborators  — nest-wide grants, EMAIL-keyed (no users table)
 *   - stewards            — scoped governance grants (document/tag/nest)
 *   - node_tag_index      — node → tag mapping for SQL-joined tag resolution
 *   - review_requests     — review workflow rows
 *   - node_versions       — version metadata (content lives with the engine)
 *   - approved_versions   — approved-version pinning per node
 *   - api_events          — activity trace (see trace-log.ts)
 *
 * NO users/sessions/api-keys/license tables — identity is a caller-supplied
 * email string (the engine actor IS the email).
 */

import type Database from "better-sqlite3";

/** Create all governance tables and indexes. Idempotent. */
export function bootstrapGovernanceSchema(db: Database.Database): void {
  db.exec(`
    -- Per-nest governance settings. One row per nest; absent row means an
    -- ungoverned private nest with no owner.
    CREATE TABLE IF NOT EXISTS nest_settings (
      nest_id TEXT PRIMARY KEY,
      owner_email TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private', 'public')),
      stewardship_enabled INTEGER NOT NULL DEFAULT 0,
      allow_self_approve INTEGER NOT NULL DEFAULT 0
    );

    -- Nest-wide collaborator grants. Email-keyed: the community server keyed
    -- these by users.id; here the email IS the identity.
    CREATE TABLE IF NOT EXISTS nest_collaborators (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('read', 'write', 'admin')),
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nest_collab_nest ON nest_collaborators(nest_id);
    CREATE INDEX IF NOT EXISTS idx_nest_collab_email ON nest_collaborators(user_email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nest_collab_uniq
      ON nest_collaborators(nest_id, user_email);

    -- Steward assignments. scope+target determines what the steward governs.
    -- Resolution priority: document(1) > tag(2) > nest(3).
    CREATE TABLE IF NOT EXISTS stewards (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('document', 'tag', 'nest')),
      node_pattern TEXT,           -- exact node id for document scope
      tag_name TEXT,               -- for tag scope (lowercased, no '#')
      user_email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reviewer'
        CHECK(role IN ('editor', 'reviewer', 'viewer')),
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_stewards_nest ON stewards(nest_id);
    CREATE INDEX IF NOT EXISTS idx_stewards_email ON stewards(user_email);
    CREATE INDEX IF NOT EXISTS idx_stewards_scope ON stewards(nest_id, scope);

    -- Partial unique indexes — one active record per (nest, scope, target, email).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stewards_uniq_nest
      ON stewards(nest_id, user_email)
      WHERE scope = 'nest' AND is_active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stewards_uniq_document
      ON stewards(nest_id, node_pattern, user_email)
      WHERE scope = 'document' AND node_pattern IS NOT NULL AND is_active = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stewards_uniq_tag
      ON stewards(nest_id, tag_name, user_email)
      WHERE scope = 'tag' AND tag_name IS NOT NULL AND is_active = 1;

    -- Resolution support indexes.
    CREATE INDEX IF NOT EXISTS idx_stewards_tag_lookup
      ON stewards(nest_id, tag_name)
      WHERE scope = 'tag' AND is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_stewards_doc_lookup
      ON stewards(nest_id, node_pattern)
      WHERE scope = 'document' AND is_active = 1;

    -- Tag index — node -> tag mapping for fast SQL-joined steward resolution.
    CREATE TABLE IF NOT EXISTS node_tag_index (
      nest_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      PRIMARY KEY (nest_id, node_id, tag_name)
    );
    CREATE INDEX IF NOT EXISTS idx_node_tag_by_tag
      ON node_tag_index(nest_id, tag_name);

    -- Review requests. Only one pending review per node (enforced in code).
    CREATE TABLE IF NOT EXISTS review_requests (
      id TEXT PRIMARY KEY,
      nest_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      requested_by TEXT NOT NULL,    -- email
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      request_note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
      resolved_by TEXT,              -- email
      resolved_at TEXT,
      resolution_note TEXT,
      is_override INTEGER NOT NULL DEFAULT 0,
      priority TEXT NOT NULL DEFAULT 'normal'
        CHECK(priority IN ('low', 'normal', 'high', 'urgent'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_nest ON review_requests(nest_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_node ON review_requests(nest_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON review_requests(nest_id, status);

    -- Node versions (metadata only; content lives with the engine vault).
    CREATE TABLE IF NOT EXISTS node_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nest_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,    -- SHA-256 of content for conflict detection
      author TEXT NOT NULL,          -- email
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'pending_review', 'approved', 'published', 'rejected')),
      change_note TEXT,
      tags_json TEXT,                -- JSON array of tags for steward resolution
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(nest_id, node_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_versions_node ON node_versions(nest_id, node_id);

    -- Approved version pinning (which version AI tools serve).
    CREATE TABLE IF NOT EXISTS approved_versions (
      nest_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      approved_version INTEGER NOT NULL,
      approved_by TEXT NOT NULL,     -- email
      approved_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (nest_id, node_id)
    );

    -- Activity trace — one row per recorded event (engine provenance,
    -- MCP/API activity). The community CHECK(kind IN ('api','mcp')) is
    -- relaxed: kind carries the client name from ProvenanceOrigin.client.
    CREATE TABLE IF NOT EXISTS api_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      method TEXT,                 -- HTTP method / provenance kind
      path TEXT,                   -- request path / document id
      tool TEXT,                   -- tool name
      nest_id TEXT,
      user_id TEXT,
      user_email TEXT,
      status INTEGER,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_events_ts ON api_events(ts);
  `);
}
