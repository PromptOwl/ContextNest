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
 * semantics, and holds no file handle open — so an abandoned lock is just an
 * empty directory whose mtime tells its age. Writers acquire with bounded
 * backoff; a lock older than STALE_MS is presumed abandoned (a crashed writer)
 * and stolen. Reads never lock.
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

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Where the lock directory lives, relative to the vault root. */
export const LOCK_DIRNAME = join(".versions", ".lock");

/** A lock older than this is presumed abandoned and stolen. */
export const STALE_MS = 30_000;

/** Total time a writer waits for the lock before giving up. */
export const ACQUIRE_TIMEOUT_MS = 20_000;

/** Backoff between acquisition attempts. Fixed: contention is milliseconds. */
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
        `another writer is holding it unusually long. Retry, or remove a stale ` +
        `${LOCK_DIRNAME} directory if no writer is running.`,
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
    return null;
  }
}

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

  for (;;) {
    try {
      // recursive:false so an existing lock throws EEXIST — the atomic test.
      // The parent .versions/ may not exist on a fresh vault; create it first
      // (recursive mkdir of the parent is idempotent and race-safe).
      await mkdir(join(root, ".versions"), { recursive: true });
      await mkdir(lockPath);
      break;
    } catch {
      const age = await lockAge(lockPath);
      if (age !== null && age > STALE_MS) {
        // Presumed crashed writer. Steal by removing and looping; if two
        // stealers race, one mkdir wins and the other keeps waiting.
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new VaultLockTimeoutError(root);
      await sleep(RETRY_DELAY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {
      // Releasing can only fail if something removed the dir already (a
      // stealer after a long pause) — the next writer's mkdir sorts it out.
    });
  }
}
