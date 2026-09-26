/**
 * Turning encryption on and off for a vault: `ctx init --encrypted`,
 * `ctx vault encrypt`, `ctx vault decrypt`.
 *
 * Neither direction is one atomic transaction — a vault is many files and no
 * filesystem gives a multi-file commit. What IS guaranteed:
 *
 *   - The key is stored BEFORE the first byte is sealed, and the recovery
 *     passphrase is returned to the caller, so no interruption can leave
 *     ciphertext without a key.
 *   - Every file is replaced atomically (temp file, fsync, rename), so each
 *     file is always either its complete plaintext or its complete ciphertext.
 *   - Reads tolerate a mixed vault (plaintext files read as-is), and both
 *     operations are RESUMABLE: rerunning finishes the job. `encryption.yaml`
 *     is the marker — written first on encrypt, deleted last on decrypt.
 *
 * Both run under the vault write lock, so no engine writer interleaves.
 */

import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { globFiles } from "../glob.js";
import { withVaultLock } from "../vault-lock.js";
import { ContextNestError } from "../errors.js";
import type { NestStorage } from "../storage.js";
import type { DocumentHistory } from "../types.js";
import { type ScryptParams, type SealKind, isArmoredText, isSealedBinary } from "./envelope.js";
import { kekAccount, type VaultKeyStore } from "./key-store.js";
import { VaultCrypto, encodeKek } from "./vault-crypto.js";

/** Basenames that are never content (mirrors storage's NON_DOCUMENT_BASENAMES). */
const NON_CONTENT = new Set(["INDEX.md", "CLAUDE.md", "GEMINI.md", "AGENTS.md", "README.md"]);

interface Target {
  rel: string;
  kind: SealKind;
}

/** Every file an encrypted vault seals, with the kind it is sealed as. */
async function sensitiveFiles(root: string): Promise<Target[]> {
  const files = await globFiles(
    root,
    [
      "**/*.md",
      "**/.versions/*/*.md",
      "**/.versions/*/*.diff",
      "**/.versions/*/*.pdf",
      "**/_suggestions/**/*.patch",
      "**/_suggestions/**/*.meta.yaml",
      "**/*.pdf",
      "context.yaml",
    ],
    ["**/node_modules/**", "**/.context/**", "CONTEXT.md"],
  );
  const out: Target[] = [];
  for (const rel of [...new Set(files)].sort()) {
    const base = rel.split("/").pop()!;
    if (rel.endsWith(".pdf")) out.push({ rel, kind: "binary" });
    else if (/(^|\/)\.versions\/[^/]+\/v\d+\.md$/.test(rel)) out.push({ rel, kind: "keyframe" });
    else if (/(^|\/)\.versions\/[^/]+\/v\d+\.diff$/.test(rel)) out.push({ rel, kind: "diff" });
    else if (rel.includes("_suggestions/")) out.push({ rel, kind: "suggestion" });
    else if (rel === "context.yaml") out.push({ rel, kind: "index" });
    else if (rel.endsWith(".md") && !NON_CONTENT.has(base)) out.push({ rel, kind: "doc" });
  }
  return out;
}

async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.enc.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export interface EncryptVaultOptions {
  keyStore?: VaultKeyStore;
  /** Override scrypt cost (tests). Production uses the OWASP default. */
  scrypt?: ScryptParams;
}

export interface EncryptVaultResult {
  /** Recovery passphrase — shown to the user ONCE. Null when resuming. */
  passphrase: string | null;
  vaultId: string;
  keyStore: string;
  sealed: number;
  resumed: boolean;
}

/**
 * Encrypt a vault in place (also used right after `init` for `--encrypted`).
 * Resumes a previously interrupted run when the vault already has key material
 * this machine can unlock.
 */
export async function encryptVault(
  storage: NestStorage,
  options: EncryptVaultOptions = {},
): Promise<EncryptVaultResult> {
  return withVaultLock(storage.root, async () => {
    let crypto = await VaultCrypto.load(storage.root, { keyStore: options.keyStore });
    let passphrase: string | null = null;
    const resumed = crypto !== null;
    if (crypto) {
      await crypto.unlock();
    } else {
      const created = VaultCrypto.create(storage.root, { keyStore: options.keyStore, scrypt: options.scrypt });
      crypto = created.crypto;
      passphrase = created.passphrase;
      // Key first, config second, content last: an interruption at any point
      // leaves a vault that can still be unlocked (or is still plaintext).
      await crypto.keyStore.set(kekAccount(crypto.config.vault_id), encodeKek(created.kek));
      await crypto.writeConfig();
    }
    storage.setVaultCrypto(crypto);

    let sealed = 0;
    for (const { rel, kind } of await sensitiveFiles(storage.root)) {
      const abs = join(storage.root, rel);
      if (kind === "binary") {
        const bytes = await readFile(abs);
        if (isSealedBinary(bytes)) continue;
        await writeAtomic(abs, await crypto.sealBytes(bytes));
      } else {
        const text = await readFile(abs, "utf-8");
        if (isArmoredText(text)) continue;
        // A root-level file without front matter is scaffold, not a node.
        if (kind === "doc" && !rel.includes("/") && !text.startsWith("---")) continue;
        await writeAtomic(abs, await crypto.sealText(kind, text));
      }
      sealed++;
    }
    // Free-text history fields (`note`, legacy inline `diff`): read (opens any
    // already sealed) and rewrite (seals the rest).
    for (const docId of (await storage.findAllHistories()).keys()) {
      const history = await storage.readHistory(docId);
      if (history) await storage.writeHistory(docId, history);
    }
    return {
      passphrase,
      vaultId: crypto.config.vault_id,
      keyStore: crypto.keyStore.name,
      sealed,
      resumed,
    };
  });
}

export interface DecryptVaultResult {
  decrypted: number;
}

/**
 * Decrypt a vault back to plain Markdown. Needs the key (store, env, or
 * recovery passphrase via `CONTEXTNEST_VAULT_PASSPHRASE`). The KEK is removed
 * from the key store only after every file is plaintext and the config is gone.
 */
export async function decryptVault(
  storage: NestStorage,
  options: { keyStore?: VaultKeyStore } = {},
): Promise<DecryptVaultResult> {
  return withVaultLock(storage.root, async () => {
    const crypto = await VaultCrypto.load(storage.root, { keyStore: options.keyStore });
    if (!crypto) {
      throw new ContextNestError("This vault is not encrypted.", "NOT_ENCRYPTED");
    }
    await crypto.unlock();
    storage.setVaultCrypto(crypto);

    // Histories are opened while the key is in hand and rewritten plain at
    // the end, once storage no longer seals.
    const histories = new Map<string, DocumentHistory>();
    for (const docId of (await storage.findAllHistories()).keys()) {
      const history = await storage.readHistory(docId);
      if (history) histories.set(docId, history);
    }

    let decrypted = 0;
    for (const { rel, kind } of await sensitiveFiles(storage.root)) {
      const abs = join(storage.root, rel);
      if (kind === "binary") {
        const bytes = await readFile(abs);
        if (!isSealedBinary(bytes)) continue;
        await writeAtomic(abs, await crypto.openBytes(bytes, rel));
      } else {
        const text = await readFile(abs, "utf-8");
        if (!isArmoredText(text)) continue;
        await writeAtomic(abs, await crypto.openText(text, kind, rel));
      }
      decrypted++;
    }

    storage.setVaultCrypto(null);
    for (const [docId, history] of histories) await storage.writeHistory(docId, history);
    await unlink(VaultCrypto.configPath(storage.root));
    await crypto.keyStore.delete(kekAccount(crypto.config.vault_id)).catch(() => false);
    return { decrypted };
  });
}
