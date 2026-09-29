/**
 * The CLI's vault key store: encrypted-vault KEKs go into the same secure
 * credential store as the PromptOwl login (OS keychain, or the AES-256-GCM
 * file store when CONTEXTNEST_CREDENTIALS_KEY is set), not a second keychain
 * implementation.
 *
 * Where neither exists (a headless Linux box without Secret Service and no
 * CONTEXTNEST_CREDENTIALS_KEY), it falls back to the engine's interim 0600
 * file store rather than refusing to create an encrypted vault. The name then
 * says so, and `ctx init --encrypted` prints the weaker guarantee. Reads check
 * both, so a vault keyed before a keychain was available still unlocks.
 */

import { InterimFileKeyStore, type VaultKeyStore } from "@promptowl/contextnest-engine";
import { CredentialStore, type CredentialStoreOptions } from "./credentials.js";

export class CliVaultKeyStore implements VaultKeyStore {
  private readonly secure: CredentialStore;
  private readonly fallback: VaultKeyStore;
  private label = "credential store";
  private osBacked = false;

  constructor(opts: CredentialStoreOptions & { fallback?: VaultKeyStore } = {}) {
    this.secure = new CredentialStore(opts);
    this.fallback = opts.fallback ?? new InterimFileKeyStore();
  }

  get name(): string {
    return this.label;
  }

  get hardwareOrOsBacked(): boolean {
    return this.osBacked;
  }

  /** The secure store when one is usable right now, else null. */
  private async target(): Promise<CredentialStore | null> {
    const where = await this.secure.describe();
    if (where.kind === "none") {
      this.label = this.fallback.name;
      this.osBacked = false;
      return null;
    }
    this.label = where.label;
    this.osBacked = where.kind === "keyring";
    return this.secure;
  }

  async get(account: string): Promise<string | null> {
    const secure = await this.target();
    const found = secure ? await secure.get(account) : null;
    if (found !== null) return found;
    const legacy = await this.fallback.get(account);
    if (legacy !== null && !secure) this.label = this.fallback.name;
    return legacy;
  }

  async set(account: string, secret: string): Promise<void> {
    const secure = await this.target();
    if (secure) await secure.set(account, secret);
    else await this.fallback.set(account, secret);
  }

  /**
   * The credential store has no delete, so a decrypted vault's KEK stays in
   * the keychain (harmless: it unlocks nothing once the vault is plaintext and
   * its encryption.yaml is gone). The interim file copy, if any, is removed.
   */
  async delete(account: string): Promise<boolean> {
    return this.fallback.delete(account);
  }
}
