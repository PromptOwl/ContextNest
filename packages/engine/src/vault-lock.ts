/**
 * Per-vault write lock — serializes the version-write + checkpoint-seal
 * critical section across processes.
 *
 * Why it exists: every mutating operation read-modify-writes the nest-level
 * `.versions/context_history.yaml` hash chain. With nothing serializing that,
 * concurrent writers corrupt it *silently* — measured with 6 parallel
 * `ctx update` processes on one vault: all bodies landed, 3 checkpoint seals
 * were lost, and `ctx verify` reported `cross_chain_mismatch`. Reachable with
 * two terminals today; guaranteed once parallel agents write the same vault.
 *
 * Mechanism: `mkdir` of `<root>/.versions/.lock`. Directory creation is atomic
 * on POSIX and Windows alike (this repo's cross-platform bar), needs no O_EXCL
 * semantics, and holds no file handle open. Writers acquire with jittered
 * bounded backoff. Reads never lock.
 *
 * Liveness vs. crash recovery: while the critical section runs, the holder
 * HEARTBEATS — refreshing the lock's mtime every HEARTBEAT_MS — so a live
 * holder is never judged stale no matter how long its write takes (a bulk
 * import, a loaded machine). Only a holder that stops heartbeating (crashed
 * process) goes stale after STALE_MS and is stolen. Each acquisition also
 * writes an OWNER TOKEN into the lock dir; release removes the lock only if
 * the token is still its own, so a holder that was somehow stolen anyway
 * (e.g. resumed after a long SIGSTOP/laptop sleep) cannot delete the next
 * writer's live lock on its way out.
 *
 * This covers every topology where one filesystem owns the vault: parallel
 * local CLI processes, and remote nests — an MCP server serving `context_*`
 * runs these same executors against *its* disk, so N cloud clients serialize
 * here without any client-side coordination.
 *
 * Deliberately out of scope, so the boundary is explicit:
 *  - several server INSTANCES over shared/object storage: a filesystem lock
 *    cannot span that. The upgrade path is optimistic concurrency the chain
 *    already enables — each seal names its parent chain_hash; reject a seal
 *    whose parent is not the current head and let the client retry.
 *  - a vault inside a Dropbox/iCloud-synced folder edited from two machines:
 *    sync-layer conflict resolution, which no lock can solve.
 */

import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Where the lock directory lives, relative to the vault root. */
export const LOCK_DIRNAME = join(".versions", ".lock");

/**
 * A lock whose heartbeat is older than this is presumed abandoned and stolen.
 * Live holders refresh well inside the window (HEARTBEAT_MS), so only a
 * crashed writer can ever cross it.
 */
export const STALE_MS = 30_000;

/** How often a live holder refreshes the lock's mtime. */
export const HEARTBEAT_MS = 10_000;

/**
 * Total time a writer waits for the lock before giving up. Deliberately
 * LONGER than STALE_MS: a waiter queued behind a crashed holder must survive
 * long enough to reach the staleness window and steal, rather than timing out
 * first and never recovering.
 */
export const ACQUIRE_TIMEOUT_MS = 60_000;

/**
 * Base backoff between acquisition attempts; each sleep adds up to the same
 * amount again as jitter so concurrent waiters don't thunder-herd on one
 * cadence. Contention is normally milliseconds.
 */
const RETRY_DELAY_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when the lock cannot be acquired within ACQUIRE_TIMEOUT_MS. */
export class VaultLockTimeoutError extends Error {
  /**
   * Stable discriminator for consumers matching across package boundaries
   * (dual CJS/ESM builds break `instanceof`). Mirrored in the api module's
   * ERROR_CODES so bindings can surface it as a typed, retryable error.
   */
  readonly code = "VAULT_LOCK_TIMEOUT";

  constructor(root: string) {
    super(
      `Could not acquire the write lock for vault at ${root} within ${ACQUIRE_TIMEOUT_MS}ms — ` +
        `another writer has been holding it (and heartbeating) the whole time. ` +
        `This is contention, not corruption: retry once the long-running write finishes. ` +
        `A crashed writer's lock is stolen automatically after ${STALE_MS}ms.`,
    );
    this.name = "VaultLockTimeoutError";
  }
}

/** Age of the current lock in ms, or null when it does not exist. */
async function lockAge(lockPath: string): Promise<number | null> {
  try {
    const s = await stat(lockPath);
    return Date.now() - s.mtimeMs;
  } catch {
    // Most commonly ENOENT (released between our EEXIST and this stat) — the
    // caller just retries mkdir. Anything else will resurface loudly on the
    // next mkdir attempt, which no longer swallows non-EEXIST errors.
    return null;
  }
}

/** The file inside the lock dir naming the current owner. */
const OWNER_FILE = "owner";

/**
 * Run `fn` while holding the vault's write lock.
 *
 * Reentrancy: none, deliberately — each mutating operation acquires once at
 * its outer edge (the executor), and nothing below re-acquires. Nesting two
 * locked operations would deadlock loudly rather than corrupt quietly, which
 * is the right failure direction for an integrity mechanism.
 */
export async function withVaultLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(root, LOCK_DIRNAME);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  const token = randomUUID();

  // The parent .versions/ may not exist on a fresh vault. Created once, up
  // front, OUTSIDE the retry loop: a failure here (EACCES, EROFS, ENOSPC,
  // a file squatting on the path) is a real filesystem problem and must
  // surface immediately, not spin for the acquire window and then masquerade
  // as lock contention.
  await mkdir(join(root, ".versions"), { recursive: true });

  for (;;) {
    try {
      // recursive:false so an existing lock throws EEXIST — the atomic test.
      await mkdir(lockPath);
      break;
    } catch (err) {
      // Only "the lock is held" is contention. Everything else is a real
      // error the caller needs to see, with its own code, right away.
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;

      const age = await lockAge(lockPath);
      if (age !== null && age > STALE_MS) {
        // No heartbeat for a whole staleness window → the holder is dead.
        // Steal by removing and looping; if two stealers race, one mkdir
        // wins and the other keeps waiting.
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new VaultLockTimeoutError(root);
      await sleep(RETRY_DELAY_MS + Math.random() * RETRY_DELAY_MS);
    }
  }

  // Ownership marker + heartbeat. Both best-effort: if the marker write or a
  // heartbeat touch fails, the lock still mutually excludes — we only lose
  // the release-safety refinement, never correctness of the critical section.
  await writeFile(join(lockPath, OWNER_FILE), token).catch(() => {});
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Release only what is still OURS. If the lock was somehow stolen (a
    // holder resumed after a long suspend), the dir now belongs to another
    // writer — removing it would let a third writer in on top of them.
    try {
      const owner = await readFile(join(lockPath, OWNER_FILE), "utf-8").catch(() => null);
      if (owner === null || owner === token) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Nothing to release, or no permission to — the staleness window
      // recovers either way.
    }
  }
}
