/**
 * Per-vault encryption state: config, keys, and seal/open for every kind of
 * vault file. `NestStorage` owns one of these (lazily) and routes each
 * sensitive read and write through it; nothing else in the engine touches
 * ciphertext.
 *
 * Key hierarchy (v1):
 *
 *   KEK  (key-encryption key)  OS key store / env. Never inside the vault.
 *    └─ DEK (data key)         `.context/encryption.yaml`, stored twice:
 *                                - wrapped by the KEK (normal unlock), and
 *                                - wrapped by scrypt(recovery passphrase), the
 *                                  passphrase shown ONCE at init/encrypt.
 *
 * The DEK seals every sensitive artifact with AES-256-GCM. Each ciphertext
 * records the id of the key that sealed it (`kid`, today the DEK id), so the
 * planned per-document keys (crypto-shred for the forget protocol) and key
 * rotation can arrive without a format change.
 *
 * Front matter stays PLAINTEXT on live documents: the file on disk is the
 * original front matter (plus a `contextnest_encrypted: 1` marker) followed by
 * an armored block holding the WHOLE original file. With the key, the engine
 * decrypts the block and ignores the projection; without it, tools can still
 * see titles/tags/status. The projection is bound into the GCM AAD, so editing
 * it by hand makes the document fail to open (loudly) instead of silently
 * diverging from the sealed original.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { ContextNestError } from "../errors.js";
import {
  DEFAULT_SCRYPT,
  DecryptionFailedError,
  HEADER_MARKER_KEY,
  KEY_BYTES,
  type ScryptParams,
  type SealKind,
  binaryKid,
  deriveFromPassphrase,
  fieldKid,
  openArmoredText,
  openBinary,
  openField,
  parseArmor,
  randomKey,
  sealArmoredText,
  sealBinary,
  sealField,
  unwrapKey,
  wrapKey,
} from "./envelope.js";
import {
  VAULT_KEY_ENV,
  type VaultKeyStore,
  getDefaultVaultKeyStore,
  kekAccount,
} from "./key-store.js";

export const ENCRYPTION_CONFIG_FILE = join(".context", "encryption.yaml");

/** Env var holding the recovery passphrase — unlocks when the key store has no KEK. */
export const VAULT_PASSPHRASE_ENV = "CONTEXTNEST_VAULT_PASSPHRASE";

export interface EncryptionConfig {
  version: 1;
  vault_id: string;
  cipher: "aes-256-gcm";
  created_at: string;
  dek: {
    id: string;
    /** DEK wrapped by the KEK. */
    wrapped: string;
  };
  recovery: {
    kdf: "scrypt";
    N: number;
    r: number;
    p: number;
    salt: string;
    /** DEK wrapped by scrypt(passphrase). */
    wrapped: string;
  };
}

/** The vault is encrypted and no key is available in this process. */
export class VaultLockedError extends ContextNestError {
  constructor(root: string) {
    super(
      `This vault is encrypted and its key is not available on this machine (${root}). ` +
        `Set ${VAULT_KEY_ENV} to the vault key, or ${VAULT_PASSPHRASE_ENV} to the recovery passphrase shown when the vault was encrypted.`,
      "VAULT_LOCKED",
    );
    this.name = "VaultLockedError";
  }
}

/** A key was found, but it does not unwrap this vault's data key. */
export class WrongVaultKeyError extends ContextNestError {
  constructor(source: string) {
    super(
      `The key from ${source} does not unlock this vault (AES-GCM authentication of the data key failed).`,
      "VAULT_KEY_MISMATCH",
    );
    this.name = "WrongVaultKeyError";
  }
}

/**
 * Plaintext front matter projection for a document: the original front matter
 * lines (LF-normalized) plus the marker key. Empty for a file with none.
 */
export function frontmatterHeader(plaintext: string): string {
  const text = plaintext.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---", 3);
  if (end === -1) return "";
  // Ends in "\n" (or is empty), so split/join keeps every line break.
  const inner = text
    .slice(4, end + 1)
    .split("\n")
    .filter((line) => !line.startsWith(`${HEADER_MARKER_KEY}:`))
    .join("\n");
  return `---\n${inner}${HEADER_MARKER_KEY}: 1\n---\n`;
}

/** 120-bit recovery passphrase, grouped for writing down: `XXXX-XXXX-…` (Crockford base32). */
export function generateRecoveryPassphrase(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(24);
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += alphabet[bytes[i] & 31];
    if (i % 4 === 3 && i < 23) out += "-";
  }
  return out;
}

export interface VaultCryptoOptions {
  keyStore?: VaultKeyStore;
  /** Explicit KEK (bypasses env + store). For tests and embedding hosts. */
  kek?: Buffer;
}

export class VaultCrypto {
  private dek: Buffer | null = null;
  private unlockError: Error | null = null;

  constructor(
    public readonly root: string,
    public readonly config: EncryptionConfig,
    private readonly options: VaultCryptoOptions = {},
  ) {}

  static configPath(root: string): string {
    return join(root, ENCRYPTION_CONFIG_FILE);
  }

  /** Load the vault's encryption config, or null for a plain vault. */
  static async load(root: string, options: VaultCryptoOptions = {}): Promise<VaultCrypto | null> {
    let raw: string;
    try {
      raw = await readFile(VaultCrypto.configPath(root), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let cfg: EncryptionConfig | undefined;
    try {
      cfg = yaml.load(raw) as EncryptionConfig | undefined;
    } catch {
      cfg = undefined;
    }
    if (!cfg || cfg.version !== 1 || cfg.cipher !== "aes-256-gcm" || !cfg.dek?.wrapped || !cfg.vault_id) {
      throw new ContextNestError(
        `${ENCRYPTION_CONFIG_FILE} is unreadable or from an unsupported version — refusing to guess whether this vault is encrypted.`,
        "ENCRYPTION_CONFIG_INVALID",
      );
    }
    return new VaultCrypto(root, cfg, options);
  }

  /**
   * Create key material for a vault that has none. Returns the handle (already
   * unlocked), the KEK the caller must put in the key store, and the recovery
   * passphrase the caller must show the user exactly once.
   */
  static create(
    root: string,
    options: VaultCryptoOptions & { scrypt?: ScryptParams; passphrase?: string } = {},
  ): { crypto: VaultCrypto; kek: Buffer; passphrase: string } {
    const vaultId = randomUUID();
    const kek = options.kek ?? randomKey();
    const dek = randomKey();
    const dekId = randomBytes(8).toString("hex");
    const passphrase = options.passphrase ?? generateRecoveryPassphrase();
    const params = options.scrypt ?? DEFAULT_SCRYPT;
    const salt = randomBytes(16);
    const recoveryKey = deriveFromPassphrase(passphrase, salt, params);
    const config: EncryptionConfig = {
      version: 1,
      vault_id: vaultId,
      cipher: "aes-256-gcm",
      created_at: new Date().toISOString(),
      dek: { id: dekId, wrapped: wrapKey(kek, dek, `dek:${vaultId}:${dekId}`) },
      recovery: {
        kdf: "scrypt",
        N: params.N,
        r: params.r,
        p: params.p,
        salt: salt.toString("base64"),
        wrapped: wrapKey(recoveryKey, dek, `recovery:${vaultId}:${dekId}`),
      },
    };
    const crypto = new VaultCrypto(root, config, { keyStore: options.keyStore, kek });
    crypto.dek = dek;
    return { crypto, kek, passphrase };
  }

  async writeConfig(): Promise<void> {
    const path = VaultCrypto.configPath(this.root);
    await mkdir(join(this.root, ".context"), { recursive: true });
    const body =
      "# Context Nest encrypted vault. Do not edit or delete: without this file AND\n" +
      "# the vault key (or the recovery passphrase) the content cannot be decrypted.\n" +
      yaml.dump(this.config, { lineWidth: -1, noRefs: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(body, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  }

  get keyStore(): VaultKeyStore {
    return this.options.keyStore ?? getDefaultVaultKeyStore();
  }

  get kid(): string {
    return this.config.dek.id;
  }

  get isUnlocked(): boolean {
    return this.dek !== null;
  }

  /**
   * Unlock, trying in order: an explicit KEK, `CONTEXTNEST_VAULT_KEY`, the key
   * store, then the recovery passphrase in `CONTEXTNEST_VAULT_PASSPHRASE`.
   * Throws VaultLockedError when none is available, WrongVaultKeyError when
   * one is found but does not fit.
   */
  async unlock(): Promise<void> {
    if (this.dek) return;
    if (this.unlockError) throw this.unlockError;
    const { vault_id, dek } = this.config;
    const attempt = (kek: Buffer, source: string): void => {
      try {
        this.dek = unwrapKey(kek, dek.wrapped, `dek:${vault_id}:${dek.id}`, "vault data key");
      } catch (err) {
        if (err instanceof DecryptionFailedError) {
          this.unlockError = new WrongVaultKeyError(source);
          throw this.unlockError;
        }
        throw err;
      }
    };
    if (this.options.kek) return attempt(this.options.kek, "the supplied key");
    const env = process.env[VAULT_KEY_ENV];
    if (env) return attempt(decodeKek(env, VAULT_KEY_ENV), VAULT_KEY_ENV);
    const stored = await this.keyStore.get(kekAccount(vault_id));
    if (stored) return attempt(decodeKek(stored, this.keyStore.name), this.keyStore.name);
    const passphrase = process.env[VAULT_PASSPHRASE_ENV];
    if (passphrase) return this.unlockWithPassphrase(passphrase, VAULT_PASSPHRASE_ENV);
    throw new VaultLockedError(this.root);
  }

  /** Unlock from the recovery passphrase. */
  unlockWithPassphrase(passphrase: string, source = "the recovery passphrase"): void {
    const { vault_id, dek, recovery } = this.config;
    const key = deriveFromPassphrase(passphrase, Buffer.from(recovery.salt, "base64"), recovery);
    try {
      this.dek = unwrapKey(key, recovery.wrapped, `recovery:${vault_id}:${dek.id}`, "vault data key");
    } catch (err) {
      if (err instanceof DecryptionFailedError) {
        this.unlockError = new WrongVaultKeyError(source);
        throw this.unlockError;
      }
      throw err;
    }
  }

  // ─── seal / open ────────────────────────────────────────────────────────

  private async key(kid: string, what: string): Promise<Buffer> {
    await this.unlock();
    if (kid !== this.config.dek.id) {
      throw new ContextNestError(
        `${what} was sealed with key ${kid}, which this vault does not hold (current key ${this.config.dek.id}). ` +
          `It was copied from another encrypted vault, or the vault's key material was replaced.`,
        "DECRYPTION_FAILED",
      );
    }
    return this.dek!;
  }

  /** Seal a text artifact. Live docs (`kind: "doc"`) keep a plaintext front matter projection. */
  async sealText(kind: SealKind, plaintext: string): Promise<string> {
    const key = await this.key(this.kid, "new ciphertext");
    const header = kind === "doc" ? frontmatterHeader(plaintext) : "";
    return sealArmoredText(key, this.kid, kind, plaintext, header);
  }

  async openText(raw: string, kind: SealKind | SealKind[], what: string): Promise<string> {
    const parts = parseArmor(raw);
    if (!parts) throw new DecryptionFailedError(what);
    return openArmoredText(await this.key(parts.kid, what), parts, kind, what);
  }

  async sealNote(plaintext: string): Promise<string> {
    return sealField(await this.key(this.kid, "new ciphertext"), this.kid, "note", plaintext);
  }

  async openNote(value: string, what: string): Promise<string> {
    const kid = fieldKid(value);
    if (!kid) throw new DecryptionFailedError(what);
    return openField(await this.key(kid, what), value, what);
  }

  async sealBytes(bytes: Uint8Array): Promise<Buffer> {
    return sealBinary(await this.key(this.kid, "new ciphertext"), this.kid, bytes);
  }

  async openBytes(bytes: Uint8Array, what: string): Promise<Buffer> {
    const kid = binaryKid(bytes);
    if (!kid) throw new DecryptionFailedError(what);
    return openBinary(await this.key(kid, what), bytes, what);
  }
}

export function decodeKek(value: string, source: string): Buffer {
  const buf = Buffer.from(value.trim(), "base64");
  if (buf.length !== KEY_BYTES) {
    throw new ContextNestError(
      `The vault key from ${source} is not a base64-encoded ${KEY_BYTES}-byte key.`,
      "INVALID_KEY",
    );
  }
  return buf;
}

export function encodeKek(kek: Buffer): string {
  return kek.toString("base64");
}
