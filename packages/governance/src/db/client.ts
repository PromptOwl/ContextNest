/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Governance DB client — SQLite only (better-sqlite3, synchronous).
 *
 * Decoupled from the community server's adapter abstraction: there is no
 * connection singleton and no Postgres path. Every service function in this
 * package takes an explicit `Database` handle, so tests and deployments
 * control the lifecycle.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bootstrapGovernanceSchema } from "./schema.js";

/**
 * Open (or create) a governance database at `path` and bootstrap the schema
 * idempotently. `":memory:"` is allowed for tests and ephemeral use.
 *
 * File-backed databases get WAL journaling and a 5s busy timeout so a
 * competing writer (external DB tool, parallel process) doesn't throw
 * SQLITE_BUSY immediately.
 */
export function openGovernanceDb(path: string): Database.Database {
  const inMemory = path === ":memory:" || path.startsWith("file::memory:");
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  if (!inMemory) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  bootstrapGovernanceSchema(db);
  return db;
}

/** The database handle every service function in this package accepts. */
export type GovernanceDb = Database.Database;
