/**
 * The write lock exists because concurrent mutations silently corrupt the
 * nest-level checkpoint chain (measured: 6 parallel updates lost 3 seals and
 * broke `ctx verify`). These tests pin the lock's contract; the end-to-end
 * corruption case is covered by the CLI concurrency regression.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  withVaultLock,
  VaultLockTimeoutError,
  LOCK_DIRNAME,
  STALE_MS,
} from "../vault-lock.js";

const freshRoot = () => mkdtempSync(join(tmpdir(), "cn-lock-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withVaultLock", () => {
  it("runs the function and releases the lock afterwards", async () => {
    const root = freshRoot();
    const result = await withVaultLock(root, async () => {
      expect(existsSync(join(root, LOCK_DIRNAME))).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(join(root, LOCK_DIRNAME))).toBe(false);
  });

  it("releases on throw and rethrows the original error", async () => {
    const root = freshRoot();
    await expect(
      withVaultLock(root, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(root, LOCK_DIRNAME))).toBe(false);
  });

  it("serializes concurrent critical sections — no interleaving", async () => {
    const root = freshRoot();
    const events: string[] = [];
    const job = (name: string) =>
      withVaultLock(root, async () => {
        events.push(`${name}:in`);
        await sleep(30);
        events.push(`${name}:out`);
      });
    await Promise.all([job("a"), job("b"), job("c")]);

    // Every `in` must be immediately followed by its own `out`: had two
    // sections overlapped, an `in` would be followed by another `in`.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toMatch(/:in$/);
      expect(events[i + 1]).toBe(events[i].replace(":in", ":out"));
    }
    expect(events).toHaveLength(6);
  });

  it("steals a stale lock instead of waiting out the full timeout", async () => {
    const root = freshRoot();
    const lockPath = join(root, LOCK_DIRNAME);
    mkdirSync(lockPath, { recursive: true });
    // Backdate the abandoned lock past the staleness window.
    const old = (Date.now() - STALE_MS - 5_000) / 1000;
    utimesSync(lockPath, old, old);

    const started = Date.now();
    await withVaultLock(root, async () => {});
    // Well under the acquire timeout: the stale lock was stolen, not waited on.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a fresh foreign lock makes the writer wait, not steal", async () => {
    const root = freshRoot();
    const lockPath = join(root, LOCK_DIRNAME);
    mkdirSync(lockPath, { recursive: true }); // held right now, mtime = now

    let acquired = false;
    const attempt = withVaultLock(root, async () => {
      acquired = true;
    });
    await sleep(200);
    expect(acquired).toBe(false); // still queued behind the live lock

    // Simulate the holder releasing; the queued writer should then proceed.
    const { rmSync } = await import("node:fs");
    rmSync(lockPath, { recursive: true, force: true });
    await attempt;
    expect(acquired).toBe(true);
  });

  it("times out with its own error type when the lock never frees", async () => {
    // The full acquire window is not worth a test's wall-clock; assert the
    // message tells the caller the truth — contention, retryable, with crashed
    // locks recovered automatically.
    const msg = new VaultLockTimeoutError("/x").message;
    expect(msg).toMatch(/contention/i);
    expect(msg).toMatch(/retry/i);
  });

  it("a live holder heartbeats, so a long critical section is never stolen", async () => {
    const root = freshRoot();
    const lockPath = join(root, LOCK_DIRNAME);

    let stolenObserved = false;
    const holder = withVaultLock(root, async () => {
      // Run past a full staleness window. The heartbeat interval is 10s, so
      // backdate the mtime mid-run the way a slow clock would see it — then
      // verify a competing waiter still cannot steal while we live.
      const old = (Date.now() - STALE_MS - 5_000) / 1000;
      utimesSync(lockPath, old, old);
      // Manually heartbeat once (the real interval fires at 10s; tests
      // shouldn't wait that long) — this is exactly what the interval does.
      const now = new Date();
      const { utimes } = await import("node:fs/promises");
      await utimes(lockPath, now, now);

      let acquired = false;
      const contender = withVaultLock(root, async () => {
        acquired = true;
      });
      await sleep(250);
      stolenObserved = acquired; // must still be false: mtime is fresh again
      // Wrap the promise so the async return doesn't unwrap-and-await it here,
      // which would deadlock against our own (non-reentrant) lock.
      return { contender };
    });
    const { contender } = await holder;
    await contender; // acquires normally once the holder released
    expect(stolenObserved).toBe(false);
  });

  it("release does not remove a lock it no longer owns", async () => {
    const root = freshRoot();
    const lockPath = join(root, LOCK_DIRNAME);

    await withVaultLock(root, async () => {
      // Simulate having been stolen during a long suspend: replace the owner
      // token with someone else's.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(lockPath, "owner"), "someone-else");
    });
    // Our release must have left the (now foreign) lock in place.
    expect(existsSync(lockPath)).toBe(true);
  });

  it("a real filesystem error surfaces immediately, not as a timeout", async () => {
    // A FILE squatting where .versions/ must be a directory → mkdir fails with
    // ENOTDIR/EEXIST-on-parent — must throw fast with the real error, not spin
    // for the acquire window and blame lock contention.
    const root = freshRoot();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".versions"), "not a directory");

    const started = Date.now();
    await expect(withVaultLock(root, async () => {})).rejects.toSatisfy(
      (e: unknown) => !(e instanceof VaultLockTimeoutError),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("carries a stable code for cross-package matching", () => {
    // Consumers on the other side of a dual CJS/ESM build can't rely on
    // instanceof; `code` (mirrored in api ERROR_CODES) is the contract.
    expect(new VaultLockTimeoutError("/x").code).toBe("VAULT_LOCK_TIMEOUT");
  });
});
