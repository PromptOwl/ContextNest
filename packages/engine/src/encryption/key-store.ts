/**
 * Where a vault's key-encryption key (KEK) lives.
 *
 * The engine codes against this small interface and does NOT ship its own OS
 * keychain integration: the credential-store work (OS keychain with an
 * AES-256-GCM file fallback) belongs to one module, and a second keychain
 * implementation here would be exactly the kind of duplicate that drifts. That
 * module registers itself through {@link setDefaultVaultKeyStore}; until it
 * does, {@link InterimFileKeyStore} is the default, and it says so loudly.
 *
 * Resolution order used by `VaultCrypto.unlock()`:
 *   1. `CONTEXTNEST_VAULT_KEY` — base64 of the 32-byte KEK. Read-only. For CI,
 *      containers and a headless MCP server; the value is a secret, treat the
 *      environment accordingly.
 *   2. The registered store (OS keychain once wired), else the interim store.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getRegistryDir } from "../registry.js";

export interface VaultKeyStore {
  /** Human-readable, shown by `ctx vault status`, e.g. "os-keychain". */
  readonly name: string;
  /**
   * True when the secret is protected by something beyond file permissions
   * (an OS keychain). `ctx vault status` and init warn when it is false.
   */
  readonly hardwareOrOsBacked: boolean;
  /** The stored secret (base64 text), or null when there is none. */
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  /** Returns false when there was nothing to delete. */
  delete(account: string): Promise<boolean>;
}

/** Account name a vault's KEK is stored under. Keyed by vault id, not path, so moves and dry-run sandboxes keep working. */
export function kekAccount(vaultId: string): string {
  return `contextnest.vault-kek.${vaultId}`;
}

/** Process-local store. For tests and for embedding hosts that manage keys themselves. */
export class MemoryKeyStore implements VaultKeyStore {
  readonly name = "memory";
  readonly hardwareOrOsBacked = false;
  private readonly secrets = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.secrets.get(account) ?? null;
  }
  async set(account: string, secret: string): Promise<void> {
    this.secrets.set(account, secret);
  }
  async delete(account: string): Promise<boolean> {
    return this.secrets.delete(account);
  }
}

/**
 * INTERIM default: one 0600 file per vault under `~/.contextnest/keys/`.
 *
 * This protects a vault folder that leaves the machine WITHOUT the home
 * directory — a synced/shared folder, a copied or backed-up vault, a repo push.
 * It does NOT protect against theft of the whole disk: the key file sits on the
 * same disk. The OS-keychain store from the credential-store module replaces
 * it via {@link setDefaultVaultKeyStore}; this class is not meant to grow into
 * a second keychain implementation.
 */
export class InterimFileKeyStore implements VaultKeyStore {
  readonly name = "interim-file (~/.contextnest/keys, 0600)";
  readonly hardwareOrOsBacked = false;
  constructor(private readonly dir: string = join(getRegistryDir(), "keys")) {}

  private path(account: string): string {
    return join(this.dir, `${account.replace(/[^A-Za-z0-9._-]/g, "_")}.key`);
  }

  async get(account: string): Promise<string | null> {
    try {
      return (await readFile(this.path(account), "utf-8")).trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.path(account);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, secret, { encoding: "utf-8", mode: 0o600 });
    // mode on create is masked by umask; set it explicitly (no-op on Windows).
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, target);
  }

  async delete(account: string): Promise<boolean> {
    try {
      await unlink(this.path(account));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }
}

let registered: VaultKeyStore | null = null;

/**
 * Install the process-wide default key store. The OS-keychain credential store
 * calls this at startup; tests call it with a {@link MemoryKeyStore}. Pass
 * `null` to fall back to the interim store.
 */
export function setDefaultVaultKeyStore(store: VaultKeyStore | null): void {
  registered = store;
}

export function getDefaultVaultKeyStore(): VaultKeyStore {
  return registered ?? new InterimFileKeyStore();
}

/** Env var holding a base64 KEK that overrides every store (read-only). */
export const VAULT_KEY_ENV = "CONTEXTNEST_VAULT_KEY";
