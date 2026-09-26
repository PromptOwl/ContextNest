/**
 * credentials.ts — encryption at rest for stored PromptOwl credentials.
 *
 *   1. OS keyring (keyring.ts) when available.
 *   2. Else ~/.promptowl/credentials.enc.json: AES-256-GCM, key =
 *      scrypt(CONTEXTNEST_CREDENTIALS_KEY, per-file salt), mode 0600.
 *   3. Else refuse with instructions. Never plaintext.
 *
 * CONTEXTNEST_CREDENTIALS_BACKEND=keyring|file pins the choice.
 *
 * The legacy plaintext ~/.promptowl/credentials.json is migrated on read:
 * written to (1) or (2), verified by reading back, then overwritten and
 * unlinked. With no secure store the read fails rather than use the file.
 * PROMPTOWL_ACCESS_TOKEN bypasses storage entirely.
 */

import fs from "node:fs";
import pathMod from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { type CommandRunner, type KeyringBackend, defaultRunner, platformKeyring } from "./keyring.js";

export const PROMPTOWL_ACCOUNT = "promptowl-cloud";

export interface CredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  runner?: CommandRunner;
  /** Inject a keyring directly (tests). `null` = none on this machine. */
  keyring?: KeyringBackend | null;
}

export class CredentialStoreError extends Error {
  override name = "CredentialStoreError";
}

export const NO_SECURE_STORE_HELP =
  "No OS keyring is available (macOS Keychain / Windows Credential Manager / Linux Secret Service) and " +
  "CONTEXTNEST_CREDENTIALS_KEY is not set, so there is nowhere safe to keep credentials. Either:\n" +
  "  - on Linux, install libsecret-tools and run inside a D-Bus desktop session, or\n" +
  "  - export CONTEXTNEST_CREDENTIALS_KEY=<long random secret> (e.g. `openssl rand -base64 32`) for the encrypted file store, or\n" +
  "  - pass the token by environment instead: PROMPTOWL_ACCESS_TOKEN.";

interface EncEntry {
  iv: string;
  tag: string;
  ct: string;
}

interface EncFile {
  v: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  entries: Record<string, EncEntry>;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1 };

function encryptEntry(key: Buffer, account: string, plaintext: string): EncEntry {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(account));
  const ct = Buffer.concat([c.update(plaintext, "utf-8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function decryptEntry(key: Buffer, account: string, e: EncEntry): string {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAAD(Buffer.from(account));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf-8");
}

/**
 * Overwrite with random bytes, fsync, unlink. Best effort on SSDs and
 * copy-on-write filesystems; the unlink is what is guaranteed.
 */
export function secureDelete(path: string): void {
  try {
    const size = fs.statSync(path).size;
    const fd = fs.openSync(path, "r+");
    try {
      if (size > 0) fs.writeSync(fd, randomBytes(size), 0, size, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fall through to unlink
  }
  fs.rmSync(path, { force: true });
}

export class CredentialStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly keyring: KeyringBackend | null;
  private keyringOk: Promise<boolean> | undefined;

  constructor(opts: CredentialStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? homedir();
    this.keyring =
      opts.keyring !== undefined
        ? opts.keyring
        : platformKeyring(opts.platform ?? process.platform, opts.runner ?? defaultRunner, this.env);
  }

  get legacyPath(): string {
    return pathMod.join(this.home, ".promptowl", "credentials.json");
  }

  get encryptedPath(): string {
    return pathMod.join(this.home, ".promptowl", "credentials.enc.json");
  }

  private get pinned(): string | undefined {
    return this.env.CONTEXTNEST_CREDENTIALS_BACKEND?.trim().toLowerCase() || undefined;
  }

  private useKeyring(): Promise<boolean> {
    if (this.pinned === "file" || !this.keyring) return Promise.resolve(false);
    this.keyringOk ??= this.keyring.available().catch(() => false);
    return this.keyringOk;
  }

  /** Where a write would go right now. */
  async describe(): Promise<{ kind: "keyring" | "file" | "none"; label: string }> {
    if (await this.useKeyring()) return { kind: "keyring", label: this.keyring!.name };
    if (this.pinned !== "keyring" && this.env.CONTEXTNEST_CREDENTIALS_KEY) {
      return { kind: "file", label: `encrypted file (${this.encryptedPath})` };
    }
    return { kind: "none", label: "none available" };
  }

  private fileKey(file: EncFile): Buffer {
    const pass = this.env.CONTEXTNEST_CREDENTIALS_KEY;
    if (!pass) {
      throw new CredentialStoreError(
        `Encrypted credentials exist at ${this.encryptedPath} but CONTEXTNEST_CREDENTIALS_KEY is not set.`,
      );
    }
    const { N, r, p, salt } = file.kdf;
    return scryptSync(pass, Buffer.from(salt, "base64"), 32, { N, r, p, maxmem: 256 * N * r });
  }

  private readFile(): EncFile | null {
    try {
      return JSON.parse(fs.readFileSync(this.encryptedPath, "utf-8")) as EncFile;
    } catch {
      return null;
    }
  }

  private decryptOrThrow(key: Buffer, account: string, e: EncEntry): string {
    try {
      return decryptEntry(key, account, e);
    } catch {
      throw new CredentialStoreError(
        `Could not decrypt ${this.encryptedPath}: CONTEXTNEST_CREDENTIALS_KEY does not match the key it was saved with.`,
      );
    }
  }

  async get(account: string): Promise<string | null> {
    if (await this.useKeyring()) {
      const v = await this.keyring!.get(account);
      if (v !== null) return v;
    }
    const file = this.pinned === "keyring" ? null : this.readFile();
    const entry = file?.entries[account];
    return file && entry ? this.decryptOrThrow(this.fileKey(file), account, entry) : null;
  }

  /** Store securely and verify by reading back. Throws when no secure store exists. */
  async set(account: string, secret: string): Promise<string> {
    const where = await this.describe();
    if (where.kind === "keyring") {
      await this.keyring!.set(account, secret);
    } else if (where.kind === "file") {
      const file: EncFile = this.readFile() ?? {
        v: 1,
        kdf: { name: "scrypt", ...SCRYPT, salt: randomBytes(16).toString("base64") },
        cipher: "aes-256-gcm",
        entries: {},
      };
      const key = this.fileKey(file);
      // One key per file: refuse to add an entry under a different key.
      for (const [acct, e] of Object.entries(file.entries)) this.decryptOrThrow(key, acct, e);
      file.entries[account] = encryptEntry(key, account, secret);
      const dir = pathMod.dirname(this.encryptedPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.encryptedPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.encryptedPath);
      try {
        fs.chmodSync(dir, 0o700);
        fs.chmodSync(this.encryptedPath, 0o600);
      } catch {
        // Windows: ACLs, not modes
      }
    } else {
      throw new CredentialStoreError(NO_SECURE_STORE_HELP);
    }
    if ((await this.get(account)) !== secret) {
      throw new CredentialStoreError(`${where.label} did not return the credential that was just written.`);
    }
    return where.label;
  }

  /**
   * The stored PromptOwl credentials object, or null. A plaintext legacy file,
   * if present, is migrated first (it wins: it is the newest write).
   */
  async loadPromptOwlCredentials(): Promise<Record<string, unknown> | null> {
    if (fs.existsSync(this.legacyPath)) {
      const raw = fs.readFileSync(this.legacyPath, "utf-8");
      JSON.parse(raw); // refuse to migrate garbage
      if ((await this.describe()).kind === "none") {
        throw new CredentialStoreError(
          `Found plaintext credentials at ${this.legacyPath}; they must move to a secure store before use.\n` +
            NO_SECURE_STORE_HELP,
        );
      }
      const label = await this.set(PROMPTOWL_ACCOUNT, raw);
      secureDelete(this.legacyPath);
      process.stderr.write(`Moved plaintext credentials from ${this.legacyPath} to ${label} and deleted the file.\n`);
    }
    const stored = await this.get(PROMPTOWL_ACCOUNT);
    return stored === null ? null : (JSON.parse(stored) as Record<string, unknown>);
  }
}

/** PROMPTOWL_ACCESS_TOKEN, else the stored credentials' access_token, else null (anonymous). */
export async function loadCloudToken(opts: CredentialStoreOptions = {}): Promise<string | null> {
  const env = opts.env ?? process.env;
  if (env.PROMPTOWL_ACCESS_TOKEN) return env.PROMPTOWL_ACCESS_TOKEN;
  const token = (await new CredentialStore(opts).loadPromptOwlCredentials())?.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}
