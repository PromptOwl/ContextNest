import { describe, it, expect, vi } from "vitest";
import {
  asPendingConfirmation,
  exitCodeFor,
  pollUntilDecided,
  resolveTimeoutMs,
  type PollResult,
  type PollOptions,
} from "../push-confirm.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** A minimal Response stand-in the state machine reads (status/ok/json). */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A fake clock: `now()` advances only when the injected `sleep` is awaited, so
 * the state machine's timeout is fully deterministic without real timers.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** A fetch that returns each queued poll body in order, then repeats the last. */
function queuedFetch(bodies: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = bodies.length > 1 ? bodies.shift()! : bodies[0];
    return jsonResponse(next.status, next.body);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const BASE: Omit<PollOptions, "fetchFn" | "sleep" | "now"> = {
  serverUrl: "https://engine.test",
  pollUrl: "/nests/n1/pending-pushes/p1",
  apiKey: "cnst_key",
  timeoutMs: 15 * 60 * 1000,
  minDelayMs: 2_000,
  maxDelayMs: 10_000,
};

// ─── asPendingConfirmation ────────────────────────────────────────────────────

describe("asPendingConfirmation", () => {
  it("recognizes a well-formed 202 pending_confirmation envelope", () => {
    const env = asPendingConfirmation(202, {
      status: "pending_confirmation",
      pending_id: "p1",
      confirm_url: "https://ui.test/confirm/p1",
      poll_url: "/nests/n1/pending-pushes/p1",
      message: "Confirm this push",
      expires_at: "2026-01-01T00:00:00Z",
    });
    expect(env).not.toBeNull();
    expect(env!.pending_id).toBe("p1");
    expect(env!.poll_url).toBe("/nests/n1/pending-pushes/p1");
  });

  it("returns null for a 200 (the normal apply path)", () => {
    expect(asPendingConfirmation(200, { published: 3 })).toBeNull();
  });

  it("returns null for a 202 whose body is not the pending shape", () => {
    expect(asPendingConfirmation(202, { status: "queued" })).toBeNull();
    expect(asPendingConfirmation(202, { status: "pending_confirmation" })).toBeNull(); // no poll_url/id
  });
});

// ─── exitCodeFor ──────────────────────────────────────────────────────────────

describe("exitCodeFor", () => {
  it("is 0 only when applied", () => {
    const r: PollResult = { status: "applied" };
    expect(exitCodeFor({ kind: "applied", result: r })).toBe(0);
    expect(exitCodeFor({ kind: "rejected", result: { status: "rejected" } })).not.toBe(0);
    expect(exitCodeFor({ kind: "expired", result: { status: "expired" } })).not.toBe(0);
    expect(exitCodeFor({ kind: "timeout" })).not.toBe(0);
  });
});

// ─── resolveTimeoutMs ─────────────────────────────────────────────────────────

describe("resolveTimeoutMs", () => {
  it("prefers an explicit --timeout (seconds → ms)", () => {
    expect(resolveTimeoutMs(30, "2026-01-01T00:00:00Z", () => 0)).toBe(30_000);
  });

  it("falls back to the server's expires_at window", () => {
    const now = () => Date.parse("2026-01-01T00:00:00Z");
    const ms = resolveTimeoutMs(undefined, "2026-01-01T00:05:00Z", now);
    expect(ms).toBe(5 * 60 * 1000);
  });

  it("defaults to 15m when there is no timeout and no usable expires_at", () => {
    expect(resolveTimeoutMs(undefined, undefined, () => 0)).toBe(15 * 60 * 1000);
    // An already-past expires_at is ignored, not turned into a zero/negative wait.
    const now = () => Date.parse("2026-01-01T00:10:00Z");
    expect(resolveTimeoutMs(undefined, "2026-01-01T00:00:00Z", now)).toBe(15 * 60 * 1000);
  });
});

// ─── pollUntilDecided: the state machine ──────────────────────────────────────

describe("pollUntilDecided", () => {
  it("202 → poll(pending) → poll(applied) resolves to an applied outcome", async () => {
    const clock = fakeClock();
    const { fetchFn, calls } = queuedFetch([
      { status: 200, body: { status: "pending", nest_name: "Team", doc_count: 3 } },
      { status: 200, body: { status: "applied", applied_node_count: 3, decided_by: "alice" } },
    ]);
    const onPending = vi.fn();

    const outcome = await pollUntilDecided({ ...BASE, fetchFn, sleep: clock.sleep, now: clock.now, onPending });

    expect(outcome.kind).toBe("applied");
    expect(exitCodeFor(outcome)).toBe(0);
    if (outcome.kind === "applied") expect(outcome.result.applied_node_count).toBe(3);
    // One still-pending tick, then the terminal poll — two fetches.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://engine.test/nests/n1/pending-pushes/p1");
    expect(onPending).toHaveBeenCalledOnce();
  });

  it("202 → poll(rejected) resolves to a rejected outcome (non-zero exit)", async () => {
    const clock = fakeClock();
    const { fetchFn } = queuedFetch([{ status: 200, body: { status: "rejected", decided_by: "bob" } }]);

    const outcome = await pollUntilDecided({ ...BASE, fetchFn, sleep: clock.sleep, now: clock.now });

    expect(outcome.kind).toBe("rejected");
    expect(exitCodeFor(outcome)).not.toBe(0);
  });

  it("resolves to expired when the server reports the push expired", async () => {
    const clock = fakeClock();
    const { fetchFn } = queuedFetch([{ status: 200, body: { status: "expired" } }]);
    const outcome = await pollUntilDecided({ ...BASE, fetchFn, sleep: clock.sleep, now: clock.now });
    expect(outcome.kind).toBe("expired");
    expect(exitCodeFor(outcome)).not.toBe(0);
  });

  it("sends the Bearer key on every poll", async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { status: "applied", applied_node_count: 1 }),
    ) as unknown as typeof fetch;
    await pollUntilDecided({ ...BASE, fetchFn, sleep: clock.sleep, now: clock.now });
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cnst_key");
  });

  it("gives up with a timeout outcome once the budget is spent while still pending", async () => {
    const clock = fakeClock();
    // Always pending — the loop must terminate on the clock, not spin forever.
    const fetchFn = vi.fn(async () => jsonResponse(200, { status: "pending" })) as unknown as typeof fetch;

    const outcome = await pollUntilDecided({
      ...BASE,
      timeoutMs: 5_000, // two 2s+ sleeps exhaust it
      fetchFn,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(outcome.kind).toBe("timeout");
    expect(exitCodeFor(outcome)).not.toBe(0);
  });

  it("retries through a transient 5xx and then resolves", async () => {
    const clock = fakeClock();
    const { fetchFn, calls } = queuedFetch([
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: { status: "applied", applied_node_count: 2 } },
    ]);
    const outcome = await pollUntilDecided({ ...BASE, fetchFn, sleep: clock.sleep, now: clock.now });
    expect(outcome.kind).toBe("applied");
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("aborts immediately on a 401 (a bad key never comes good)", async () => {
    const clock = fakeClock();
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: "unauthorized" })) as unknown as typeof fetch;
    await expect(
      pollUntilDecided({ ...BASE, fetchFn, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/not authorized/i);
  });

  it("caps the backoff at maxDelayMs", async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    };
    // Enough pending ticks to climb 2s→4s→8s→10s(cap).
    const bodies = Array.from({ length: 6 }, () => ({ status: 200, body: { status: "pending" as const } }));
    const applied = { status: 200, body: { status: "applied", applied_node_count: 1 } };
    const { fetchFn } = queuedFetch([...bodies, applied]);

    await pollUntilDecided({
      ...BASE,
      timeoutMs: 10 * 60 * 1000,
      fetchFn,
      sleep,
      now: clock.now,
    });

    expect(sleeps[0]).toBe(2_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(10_000);
    expect(sleeps.some((s) => s === 10_000)).toBe(true);
  });
});
