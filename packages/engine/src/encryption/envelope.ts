/**
 * Low-level encryption primitives for encrypted vaults.
 *
 * Node built-ins only (`node:crypto`) — no third-party crypto. Everything here
 * is AES-256-GCM with a fresh random 96-bit IV per seal; the 128-bit GCM tag is
 * what turns any tampering (one flipped byte of ciphertext, IV, tag, header or
 * kind) into a hard failure instead of garbage plaintext.
 *
 * Three on-disk shapes, all of which carry the id of the key that sealed them
 * (`kid`) and a `kind` (what slot the bytes belong to) inside the GCM AAD:
 *
 *   - ARMORED TEXT — documents, keyframes, diffs, suggestion files, the index.
 *     Optional plaintext header (YAML between `---` fences, bound as AAD), then
 *     a `-----BEGIN CONTEXTNEST ENCRYPTED-----` block of base64.
 *   - SEALED FIELD — one YAML scalar (a history entry's `note`/legacy `diff`):
 *     `cnenc1:<kind>:<kid>:<iv>:<tag>:<ct>`, base64url, single line.
 *   - BINARY — pdf sidecars and archived binaries: a magic prefix + header.
 *
 * Binding `kind` stops a keyframe being replayed into a diff slot (or a doc
 * into the index). Paths are deliberately NOT bound, so a folder move/rename of
 * ciphertext keeps working; swapping one document's (or version's) ciphertext
 * for another's is caught by the hash chain (`ctx verify`), exactly as a
 * plaintext swap is in a plain vault. `kid` names the sealing key so per-
 * document keys (crypto-shred) and rotation can land without a format change.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { ContextNestError } from "../errors.js";

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

export const ARMOR_BEGIN = "-----BEGIN CONTEXTNEST ENCRYPTED-----";
export const ARMOR_END = "-----END CONTEXTNEST ENCRYPTED-----";
/** Key present in every plaintext header so a header is never mistaken for a real frontmatter. */
export const HEADER_MARKER_KEY = "contextnest_encrypted";
const FIELD_PREFIX = "cnenc1:";
const BINARY_MAGIC = Buffer.from("CNENC1\n", "latin1");

/** What slot a sealed payload belongs to. Bound into the AAD. */
export type SealKind =
  | "doc"
  | "keyframe"
  | "diff"
  | "suggestion"
  | "index"
  | "note"
  | "binary";

/** GCM authentication failed: wrong key, or the bytes were altered. */
export class DecryptionFailedError extends ContextNestError {
  constructor(what: string) {
    super(
      `Decryption failed for ${what}: wrong key, or the ciphertext/header was tampered with (AES-GCM authentication failed).`,
      "DECRYPTION_FAILED",
    );
    this.name = "DecryptionFailedError";
  }
}

export interface Sealed {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new ContextNestError(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`, "INVALID_KEY");
  }
}

export function gcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

export function gcmOpen(key: Buffer, sealed: Sealed, aad: Buffer, what = "payload"): Buffer {
  assertKey(key);
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
    throw new DecryptionFailedError(what);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ct), decipher.final()]);
  } catch {
    throw new DecryptionFailedError(what);
  }
}

function aadFor(kind: SealKind, kid: string, header: string): Buffer {
  return Buffer.from(`contextnest:v1\n${kind}\n${kid}\n${header}`, "utf-8");
}

/** Line endings normalized the same way the hash chain normalizes content. */
function lf(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ─── Armored text ─────────────────────────────────────────────────────────────

const ARMOR_RE = new RegExp(
  `^(---\\n(?:[^\\n]*\\n)*?---\\n)?${ARMOR_BEGIN}\\n` +
    `cn1 ([a-z-]+) ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)\\n` +
    `([A-Za-z0-9+/=\\n]*)${ARMOR_END}\\n?$`,
);

/**
 * Whether `raw` is an armored ciphertext file. Strict on purpose: a plaintext
 * note that merely QUOTES the armor lines (documentation about this format,
 * say) must not be mistaken for ciphertext, so the whole file has to match and
 * a header, if present, must carry the marker key.
 */
export function isArmoredText(raw: string): boolean {
  // Cheap pre-check: every plaintext read in a plain vault passes through here.
  if (!raw.includes(ARMOR_BEGIN)) return false;
  const m = ARMOR_RE.exec(lf(raw));
  if (!m) return false;
  return m[1] === undefined || m[1].includes(`\n${HEADER_MARKER_KEY}:`);
}

export interface ArmorParts {
  header: string;
  kind: SealKind;
  kid: string;
  sealed: Sealed;
}

export function parseArmor(raw: string): ArmorParts | null {
  const m = ARMOR_RE.exec(lf(raw));
  if (!m) return null;
  const header = m[1] ?? "";
  if (header && !header.includes(`\n${HEADER_MARKER_KEY}:`)) return null;
  return {
    header,
    kind: m[2] as SealKind,
    kid: m[3],
    sealed: {
      iv: Buffer.from(m[4], "base64url"),
      tag: Buffer.from(m[5], "base64url"),
      ct: Buffer.from(m[6].replace(/\n/g, ""), "base64"),
    },
  };
}

export function sealArmoredText(
  key: Buffer,
  kid: string,
  kind: SealKind,
  plaintext: string,
  header = "",
): string {
  const h = lf(header);
  const { iv, tag, ct } = gcmSeal(key, Buffer.from(plaintext, "utf-8"), aadFor(kind, kid, h));
  const b64 = ct.toString("base64").replace(/(.{76})/g, "$1\n").replace(/\n$/, "");
  return (
    h +
    `${ARMOR_BEGIN}\n` +
    `cn1 ${kind} ${kid} ${iv.toString("base64url")} ${tag.toString("base64url")}\n` +
    (b64 ? `${b64}\n` : "") +
    `${ARMOR_END}\n`
  );
}

export function openArmoredText(
  key: Buffer,
  parts: ArmorParts,
  expectedKind: SealKind | SealKind[],
  what: string,
): string {
  const kinds = Array.isArray(expectedKind) ? expectedKind : [expectedKind];
  if (!kinds.includes(parts.kind)) {
    throw new ContextNestError(
      `${what} holds a "${parts.kind}" ciphertext where a "${kinds.join('" or "')}" was expected — refusing to substitute.`,
      "DECRYPTION_FAILED",
    );
  }
  return gcmOpen(key, parts.sealed, aadFor(parts.kind, parts.kid, parts.header), what).toString("utf-8");
}

// ─── Sealed YAML field ────────────────────────────────────────────────────────

export function isSealedField(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(FIELD_PREFIX);
}

export function fieldKid(value: string): string | null {
  const parts = value.slice(FIELD_PREFIX.length).split(":");
  return parts.length === 5 ? parts[1] : null;
}

export function sealField(key: Buffer, kid: string, kind: SealKind, plaintext: string): string {
  const { iv, tag, ct } = gcmSeal(key, Buffer.from(plaintext, "utf-8"), aadFor(kind, kid, ""));
  return `${FIELD_PREFIX}${kind}:${kid}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function openField(key: Buffer, value: string, what: string): string {
  const parts = value.slice(FIELD_PREFIX.length).split(":");
  if (parts.length !== 5) throw new DecryptionFailedError(what);
  const [kind, kid, iv, tag, ct] = parts;
  return gcmOpen(
    key,
    { iv: Buffer.from(iv, "base64url"), tag: Buffer.from(tag, "base64url"), ct: Buffer.from(ct, "base64url") },
    aadFor(kind as SealKind, kid, ""),
    what,
  ).toString("utf-8");
}

// ─── Binary ───────────────────────────────────────────────────────────────────

export function isSealedBinary(bytes: Uint8Array): boolean {
  return bytes.length > BINARY_MAGIC.length && Buffer.from(bytes.subarray(0, BINARY_MAGIC.length)).equals(BINARY_MAGIC);
}

/** Layout: MAGIC | kidLen(1) | kid | iv(12) | tag(16) | ct */
export function sealBinary(key: Buffer, kid: string, bytes: Uint8Array): Buffer {
  const { iv, tag, ct } = gcmSeal(key, Buffer.from(bytes), aadFor("binary", kid, ""));
  const kidBuf = Buffer.from(kid, "latin1");
  return Buffer.concat([BINARY_MAGIC, Buffer.from([kidBuf.length]), kidBuf, iv, tag, ct]);
}

export function binaryKid(bytes: Uint8Array): string | null {
  if (!isSealedBinary(bytes)) return null;
  const buf = Buffer.from(bytes);
  const len = buf[BINARY_MAGIC.length];
  return buf.subarray(BINARY_MAGIC.length + 1, BINARY_MAGIC.length + 1 + len).toString("latin1");
}

export function openBinary(key: Buffer, bytes: Uint8Array, what: string): Buffer {
  const buf = Buffer.from(bytes);
  let at = BINARY_MAGIC.length;
  const len = buf[at];
  at += 1;
  const kid = buf.subarray(at, at + len).toString("latin1");
  at += len;
  const iv = buf.subarray(at, at + IV_BYTES);
  at += IV_BYTES;
  const tag = buf.subarray(at, at + TAG_BYTES);
  at += TAG_BYTES;
  return gcmOpen(key, { iv, tag, ct: buf.subarray(at) }, aadFor("binary", kid, ""), what);
}

// ─── Key wrapping ─────────────────────────────────────────────────────────────

/** Wrap a key under another key. Output: base64url `iv.tag.ct`. */
export function wrapKey(kek: Buffer, key: Buffer, context: string): string {
  const { iv, tag, ct } = gcmSeal(kek, key, Buffer.from(`contextnest:wrap:v1\n${context}`, "utf-8"));
  return [iv, tag, ct].map((b) => b.toString("base64url")).join(".");
}

export function unwrapKey(kek: Buffer, wrapped: string, context: string, what: string): Buffer {
  const [iv, tag, ct] = wrapped.split(".").map((p) => Buffer.from(p ?? "", "base64url"));
  if (!iv || !tag || !ct) throw new DecryptionFailedError(what);
  const key = gcmOpen(kek, { iv, tag, ct }, Buffer.from(`contextnest:wrap:v1\n${context}`, "utf-8"), what);
  assertKey(key);
  return key;
}

// ─── Passphrase (recovery backup) ─────────────────────────────────────────────

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP-recommended scrypt cost for an interactive-once operation. ~128 MiB. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

export function deriveFromPassphrase(passphrase: string, salt: Buffer, params: ScryptParams): Buffer {
  if (passphrase.length < 12) {
    throw new ContextNestError(
      "Recovery passphrase must be at least 12 characters — it is the only thing standing between a stolen backup file and your vault key.",
      "WEAK_PASSPHRASE",
    );
  }
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r + 1024 * 1024,
  });
}
