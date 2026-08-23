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
 * Tradeoff: one small JSON file per session, never cleaned up. At a few dozen
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

/** Kinds of work the Stop hook can queue for the next turn to dispatch. */
export const PENDING_KINDS = ["capture", "change"];

/**
 * The value returned when no usable ledger exists.
 *
 * `pending` is the queued job the Stop hook parks instead of blocking the turn.
 * The next UserPromptSubmit drains it and dispatches a background subagent, so
 * the vault work overlaps the user's next request instead of delaying the end
 * of their last one.
 */
const EMPTY = { lastGatedTurn: null, captured: [], pending: null };

/**
 * Validate a parked job read back off disk. Anything malformed becomes `null`
 * (no job) rather than an error: a corrupt ledger must cost at most one missed
 * capture, never a broken session.
 */
function readPending(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!PENDING_KINDS.includes(raw.kind)) return null;
  if (typeof raw.reason !== "string" || raw.reason.length === 0) return null;
  const turn = typeof raw.turn === "number" && Number.isFinite(raw.turn) ? raw.turn : null;
  return { kind: raw.kind, reason: raw.reason, turn };
}

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
      pending: readPending(parsed.pending),
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
 * Writes an explicit projection rather than spreading `state`, so a stray key
 * can never reach disk. The flip side: every field the ledger carries must be
 * named here, or it is silently dropped.
 *
 * @param {string} sessionId
 * @param {{lastGatedTurn: number|null, captured?: string[], pending?: object|null}} state
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
        lastGatedTurn: state.lastGatedTurn ?? null,
        captured: (state.captured || []).slice(-50),
        pending: readPending(state.pending),
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

/**
 * Queue work for the next turn to dispatch, instead of blocking this one.
 *
 * Returns the ledger as it now stands so a caller can keep using it without a
 * re-read, whether or not the write actually landed (an unusable session id
 * persists nothing — the job is simply lost, which costs one missed capture).
 */
export function parkJob(sessionId, ledger, job, io = {}) {
  const next = { ...ledger, pending: job };
  saveLedger(sessionId, next, io);
  return next;
}

/**
 * Drop the queued job — called once the next turn has dispatched it.
 *
 * Draining is unconditional: a job is handed over exactly once, and a dispatch
 * the model then ignores is not re-offered. Re-offering would turn one missed
 * capture into a directive that reappears on every prompt, which is the noise
 * this whole design exists to avoid.
 */
export function clearPending(sessionId, ledger, io = {}) {
  if (!ledger?.pending) return ledger;
  const next = { ...ledger, pending: null };
  saveLedger(sessionId, next, io);
  return next;
}
