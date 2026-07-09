/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * Activity trace — one row per recorded event, so the deployment operator
 * has a single place to see everything clients and agents did. Deliberately
 * simple: who, what, where, outcome, duration. This is an operator audit
 * surface, NOT product telemetry — it never leaves the machine.
 *
 * Decoupled from the community server's HTTP layer: no route, no users-table
 * join (`user_email` is authoritative), and `kind` is an open string (the
 * engine's `ProvenanceOrigin.client` — e.g. "claude-code", "mcp") rather
 * than the server's 'api' | 'mcp' enum.
 *
 * Writes are best-effort fire-and-forget: a broken trace table must never
 * fail a real operation. Retention is a rolling window pruned
 * opportunistically every PRUNE_EVERY inserts.
 */

import type { GovernanceDb } from "./db/client.js";

const RETENTION_DAYS = 14;
const PRUNE_EVERY = 500;
let insertsSincePrune = 0;

export interface TraceEvent {
  /** Client/channel that produced the event (e.g. "mcp", "claude-code"). */
  kind: string;
  method?: string;
  path?: string;
  tool?: string;
  nestId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  status?: number;
  durationMs?: number;
}

export function logTraceEvent(db: GovernanceDb, e: TraceEvent): void {
  try {
    db.prepare(
      `INSERT INTO api_events
         (ts, kind, method, path, tool, nest_id, user_id, user_email, status, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      e.kind,
      e.method ?? null,
      e.path ?? null,
      e.tool ?? null,
      e.nestId ?? null,
      e.userId ?? null,
      e.userEmail ?? null,
      e.status ?? null,
      e.durationMs ?? null,
    );
    if (++insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0;
      const cutoff = new Date(
        Date.now() - RETENTION_DAYS * 86_400_000,
      ).toISOString();
      db.prepare("DELETE FROM api_events WHERE ts < ?").run(cutoff);
    }
  } catch {
    /* tracing must never break the operation */
  }
}

export interface TraceFilters {
  limit?: number;
  offset?: number;
  kind?: string;
  nestId?: string;
  user?: string;
}

export interface TraceRow {
  id: number;
  ts: string;
  kind: string;
  method: string | null;
  path: string | null;
  tool: string | null;
  nest_id: string | null;
  user_id: string | null;
  user_email: string | null;
  status: number | null;
  duration_ms: number | null;
}

export interface TracePage {
  events: TraceRow[];
  total: number;
}

export function listTraceEvents(
  db: GovernanceDb,
  filters: TraceFilters = {},
): TracePage {
  // Guard NaN/Infinity from malformed limit/offset — Math.min/max would
  // propagate NaN into the bound param and throw at the driver. Fall back to
  // a 25-row page from offset 0.
  const limit = Number.isFinite(filters.limit)
    ? Math.min(Math.max(filters.limit as number, 1), 1000)
    : 25;
  const offset = Number.isFinite(filters.offset)
    ? Math.max(filters.offset as number, 0)
    : 0;
  const where: string[] = [];
  const args: unknown[] = [];
  if (filters.kind) {
    where.push("kind = ?");
    args.push(filters.kind);
  }
  if (filters.nestId) {
    where.push("nest_id = ?");
    args.push(filters.nestId);
  }
  if (filters.user) {
    where.push("(user_email LIKE ? OR user_id = ?)");
    args.push(`%${filters.user}%`, filters.user);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  try {
    // total (filtered) drives the pager; the page itself is a windowed slice.
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM api_events${whereSql}`)
      .get(...args) as { n: number } | undefined;
    const total = Number(totalRow?.n ?? 0);
    const events = db
      .prepare(
        `SELECT * FROM api_events${whereSql}
          ORDER BY id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as TraceRow[];
    return { events, total };
  } catch {
    // A missing table or any read error degrades to empty rather than
    // failing the caller.
    return { events: [], total: 0 };
  }
}
