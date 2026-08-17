/**
 * Context Nest plugin — per-session capture ledger.
 *
 * The gate used to fire on every substantive turn, which in a coding session is
 * every turn. The ledger is the cooldown: it remembers which user turn last
 * triggered a capture pass so an ambient (unasked-for) pass can only recur
 * after a few more turns of actual conversation. Explicit user intent bypasses
 * it entirely — a cooldown must never swallow "remember this".
 *
 * State lives outside the plugin folder, next to the settings override file
 * (`~/.contextnest/`), so it survives plugin reinstalls and is inspectable.
 *
 * Every function here is total: a missing directory, an unreadable file, a
 * malformed JSON blob, or a read-only home all degrade to "no ledger", never to
 * a throw. A hook must not break a session over bookkeeping.
 *
 * ponytail: one small JSON file per session, never cleaned up. At a few dozen
 * bytes each that is cheaper than any reaping scheme would be to run or to get
 * wrong. If the directory ever needs bounding, delete by mtime on load — do not
 * add a daemon.
 *
 * SINGLE SOURCE OF TRUTH: plugins/shared/core/. Edit here, then `pnpm plugins:sync`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/** Directory holding per-session state, relative to the home directory. */
export const STATE_DIR = join(".contextnest", "plugin-state");

/** Ambient captures may not recur until this many user turns have passed. */
export const DEFAULT_MIN_TURNS = 5;

/** The value returned when no usable ledger exists. */
const EMPTY = { lastGatedTurn: null, captured: [] };

/**
 * Session ids come from the hook payload, so they are untrusted input that
 * would otherwise be pasted straight into a filesystem path. Only the shape
 * Claude Code actually emits is allowed through; anything else yields null,
 * which callers treat as "don't persist" rather than as an error.
 */
export function sessionFileName(sessionId) {
  if (typeof sessionId !== "string") return null;
  const clean = sessionId.trim();
  if (!clean || clean.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) return null;
  return `${clean}.json`;
}

/** Absolute path of a session's ledger file, or null when the id is unusable. */
export function ledgerPath(sessionId, { homedir = osHomedir() } = {}) {
  const name = sessionFileName(sessionId);
  return name ? join(homedir, STATE_DIR, name) : null;
}

/**
 * Read a session's ledger. Returns `EMPTY` for a first turn, an unusable
 * session id, or any read/parse failure.
 *
 * @param {string} sessionId
 * @param {{homedir?: string, read?: (p: string) => string}} [io] injection for tests
 */
export function loadLedger(sessionId, io = {}) {
  const path = ledgerPath(sessionId, io);
  if (!path) return { ...EMPTY };
  const read = io.read || ((p) => readFileSync(p, "utf-8"));
  try {
    const parsed = JSON.parse(read(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY };
    return {
      lastGatedTurn:
        typeof parsed.lastGatedTurn === "number" && Number.isFinite(parsed.lastGatedTurn)
          ? parsed.lastGatedTurn
          : null,
      captured: Array.isArray(parsed.captured)
        ? parsed.captured.filter((h) => typeof h === "string")
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Record that a capture pass fired at `turn`. Best-effort: a failure to write
 * only costs a slightly chattier next turn, so it is swallowed.
 *
 * `captured` is capped so a long session cannot grow the file without bound;
 * the recent headlines are the useful ones for dedupe.
 *
 * @param {string} sessionId
 * @param {{lastGatedTurn: number, captured?: string[]}} state
 * @param {{homedir?: string, write?: Function, mkdir?: Function}} [io]
 */
export function saveLedger(sessionId, state, io = {}) {
  const path = ledgerPath(sessionId, io);
  if (!path) return false;
  const write = io.write || ((p, data) => writeFileSync(p, data, "utf-8"));
  const mkdir = io.mkdir || ((p) => mkdirSync(p, { recursive: true }));
  try {
    mkdir(join(io.homedir || osHomedir(), STATE_DIR));
    write(
      path,
      JSON.stringify({
        lastGatedTurn: state.lastGatedTurn,
        captured: (state.captured || []).slice(-50),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * True when an ambient capture pass is still within its cooldown window.
 *
 * A session that has never gated counts from turn 0, not from "no window at
 * all": the clock starts when the session does. That means a short session is
 * never interrupted by an unasked-for capture pass — you have to either talk
 * long enough to earn one, or just say "remember this", which bypasses this
 * check entirely.
 */
export function inCooldown(ledger, currentTurn, minTurns = DEFAULT_MIN_TURNS) {
  const last = typeof ledger?.lastGatedTurn === "number" ? ledger.lastGatedTurn : 0;
  return currentTurn - last < minTurns;
}
