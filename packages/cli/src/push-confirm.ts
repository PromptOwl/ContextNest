/**
 * Push confirmation gate for `ctx push`.
 *
 * A hosted nest can require a human to confirm an incoming push in the web UI
 * before it is applied. When it does, the publish endpoint answers `202` with a
 * `pending_confirmation` envelope instead of applying the documents, and the
 * decision lands later. Treating that 202 as success (any 2xx used to print
 * "Pushed N documents") would misreport a push that never applied — so the CLI
 * has to recognise the pending envelope and, unless told not to, wait for the
 * decision by polling the URL the server hands back.
 *
 * The wire contract is shared with the Community server (paired PR in
 * PromptOwl/contextnest-community) and must not drift:
 *
 *   Normal push  → 200 { published, context_md_updated, node_ids }   (unchanged)
 *   Gated push   → 202 { status: "pending_confirmation", pending_id,
 *                          confirm_url, poll_url, message, expires_at }
 *   Poll GET     → 200 { status: "pending" | "applied" | "rejected" | "expired",
 *                          nest_name, doc_count, decided_by?, applied_node_count? }
 *   where poll_url = /nests/:id/pending-pushes/:pid
 *
 * The polling state machine is deliberately free of wall-clock and network
 * dependencies except through injectable `fetchFn` / `sleep` / `now`, so the
 * branching (202 → poll → applied / rejected / expired / timeout) is unit
 * testable with a mocked fetch and a fake clock — no real timers, no sockets.
 */

import { NO_REDIRECT, assertNotRedirected } from "./safety.js";

// ─── Wire shapes ──────────────────────────────────────────────────────────────

/** The 202 envelope a gated nest returns instead of applying the push. */
export interface PendingConfirmation {
  status: "pending_confirmation";
  pending_id: string;
  confirm_url: string;
  /** Path (starts with `/`) to poll, e.g. `/nests/:id/pending-pushes/:pid`. */
  poll_url: string;
  message: string;
  /** ISO timestamp after which the pending push is auto-expired, if provided. */
  expires_at?: string;
}

export type PollStatus = "pending" | "applied" | "rejected" | "expired";

/** The body of a poll response. */
export interface PollResult {
  status: PollStatus;
  nest_name?: string;
  doc_count?: number;
  decided_by?: string;
  applied_node_count?: number;
}

/**
 * Recognise a POST response as the pending-confirmation envelope. Returns the
 * parsed envelope for a well-formed `202 pending_confirmation`, or null for
 * anything else (the caller keeps its existing 200 handling). A 202 whose body
 * is *not* the pending shape is treated as unrecognised (null) so the caller
 * can surface it rather than silently claiming success.
 */
export function asPendingConfirmation(status: number, body: unknown): PendingConfirmation | null {
  if (status !== 202) return null;
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.status !== "pending_confirmation") return null;
  if (typeof b.poll_url !== "string" || typeof b.pending_id !== "string") return null;
  return {
    status: "pending_confirmation",
    pending_id: b.pending_id,
    confirm_url: typeof b.confirm_url === "string" ? b.confirm_url : "",
    poll_url: b.poll_url,
    message: typeof b.message === "string" ? b.message : "",
    expires_at: typeof b.expires_at === "string" ? b.expires_at : undefined,
  };
}

// ─── Terminal outcome ─────────────────────────────────────────────────────────

export type TerminalOutcome =
  | { kind: "applied"; result: PollResult }
  | { kind: "rejected"; result: PollResult }
  | { kind: "expired"; result: PollResult }
  | { kind: "timeout" };

/** Process exit code for an outcome: 0 only when the push actually applied. */
export function exitCodeFor(outcome: TerminalOutcome): number {
  return outcome.kind === "applied" ? 0 : 1;
}

// ─── Timeout resolution ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_TIMEOUT_MS = 1_000;

/**
 * Decide how long to wait for a decision.
 *
 * Explicit `--timeout <sec>` always wins. Otherwise fall back to the window the
 * server itself advertised via `expires_at`, and if there is none (or it has
 * already passed), the 15-minute default.
 */
export function resolveTimeoutMs(
  timeoutSec: number | undefined,
  expiresAt: string | undefined,
  now: () => number = Date.now,
): number {
  if (typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0) {
    return Math.max(MIN_TIMEOUT_MS, Math.round(timeoutSec * 1000));
  }
  if (expiresAt) {
    const at = Date.parse(expiresAt);
    if (!Number.isNaN(at)) {
      const remaining = at - now();
      if (remaining > 0) return Math.max(MIN_TIMEOUT_MS, remaining);
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

// ─── Polling state machine ────────────────────────────────────────────────────

export interface PollOptions {
  /** Hosted engine URL, trailing slash already trimmed. */
  serverUrl: string;
  /** `poll_url` from the server — an absolute path beginning with `/`. */
  pollUrl: string;
  apiKey: string;
  /** Overall budget before giving up with a `timeout` outcome. */
  timeoutMs: number;
  /** Backoff floor (default 2s) and ceiling (default 10s). */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable seams — real implementations are the defaults. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called before each wait with the still-pending poll result. */
  onPending?: (attempt: number, result: PollResult) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `poll_url` until the server reports a terminal decision or the overall
 * timeout is spent. Uncapped growth would either hammer the server or sleep
 * past a decision, so the delay climbs from `minDelayMs` toward `maxDelayMs`
 * and every sleep is clamped to the time left on the clock.
 *
 * A 401/403 is fatal (a bad key will never come good, so spinning for the whole
 * timeout helps nobody). Any other transient failure — a 5xx, a 404 before the
 * record is queryable, or a dropped connection — is retried until the deadline,
 * then reported as a timeout.
 */
export async function pollUntilDecided(opts: PollOptions): Promise<TerminalOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const minDelay = opts.minDelayMs ?? 2_000;
  const maxDelay = opts.maxDelayMs ?? 10_000;

  const url = `${opts.serverUrl}${opts.pollUrl}`;
  const deadline = now() + opts.timeoutMs;
  let delay = minDelay;
  let attempt = 0;

  while (true) {
    attempt++;
    let result: PollResult | null = null;
    try {
      const res = await fetchFn(url, {
        ...NO_REDIRECT,
        method: "GET",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
      });
      assertNotRedirected(res, "--server");
      if (res.status === 401 || res.status === 403) {
        throw new Error(`poll rejected (${res.status}) — the API key is not authorized for this nest`);
      }
      if (res.ok) {
        result = (await res.json()) as PollResult;
      }
      // A non-ok, non-auth status (5xx, 404) leaves result null → retried below.
    } catch (err) {
      // A hard auth failure is not recoverable; re-throw for the caller to
      // report. Everything else is a transient blip we retry through.
      if (err instanceof Error && /not authorized/.test(err.message)) throw err;
      result = null;
    }

    if (result) {
      if (result.status === "applied") return { kind: "applied", result };
      if (result.status === "rejected") return { kind: "rejected", result };
      if (result.status === "expired") return { kind: "expired", result };
      // status === "pending" (or an unknown value treated as still-pending)
      opts.onPending?.(attempt, result);
    }

    const remaining = deadline - now();
    if (remaining <= 0) return { kind: "timeout" };
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, maxDelay);
  }
}
