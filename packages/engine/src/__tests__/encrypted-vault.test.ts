import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestStorage } from "../storage.js";
import { serializeDocument } from "../parser.js";
import { publishDocument } from "../publish.js";
import { VersionManager } from "../versioning.js";
import type { ContextNode } from "../types.js";
import {
  MemoryKeyStore,
  kekAccount,
  setDefaultVaultKeyStore,
  VAULT_KEY_ENV,
} from "../encryption/key-store.js";
import {
  VAULT_PASSPHRASE_ENV,
  VaultLockedError,
  WrongVaultKeyError,
} from "../encryption/vault-crypto.js";
import { DecryptionFailedError, isArmoredText } from "../encryption/envelope.js";
import { encryptVault, decryptVault } from "../encryption/migrate.js";

// Cheap scrypt for tests; production uses N=2^17.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const SECRET = "SECRET-BODY-TOKEN-7f3a";
const SECRET_V2 = "SECOND-REVISION-TOKEN-91c2";
const TITLE = "Quarterly Plan";

let store: MemoryKeyStore;
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ctxnest-enc-"));
  dirs.push(d);
  return d;
}

async function writeDraft(storage: NestStorage, id: string, body: string): Promise<void> {
  const node: ContextNode = {
    id,
    filePath: "",
    rawContent: "",
    frontmatter: { title: TITLE, type: "document", status: "draft", tags: ["#plan"] },
    body,
  };
  await storage.writeDocument(id, serializeDocument(node));
}

/** v1 (keyframe) + v2 (diff) + v3 (diff): every artifact kind the chain has. */
async function seedHistory(storage: NestStorage): Promise<void> {
  await writeDraft(storage, "nodes/plan", `\n# Plan\n\n${SECRET}\n`);
  await publishDocument(storage, "nodes/plan", { editedBy: "a@x", note: "first" });
  const v1 = await storage.readDocument("nodes/plan");
  await storage.writeDocument("nodes/plan", v1.rawContent.replace(SECRET, `${SECRET}\n\n${SECRET_V2}`));
  await publishDocument(storage, "nodes/plan", { editedBy: "a@x", note: "NOTE-TOKEN-second" });
  const v2 = await storage.readDocument("nodes/plan");
  await storage.writeDocument("nodes/plan", v2.rawContent + "\nOne more line.\n");
  await publishDocument(storage, "nodes/plan", { editedBy: "a@x" });
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

/** Every file in the vault whose bytes contain `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const f of await allFiles(dir)) {
    if ((await readFile(f)).includes(needle)) hits.push(f);
  }
  return hits;
}

beforeEach(() => {
  store = new MemoryKeyStore();
  setDefaultVaultKeyStore(store);
  delete process.env[VAULT_KEY_ENV];
  delete process.env[VAULT_PASSPHRASE_ENV];
});

afterEach(async () => {
  setDefaultVaultKeyStore(null);
  delete process.env[VAULT_PASSPHRASE_ENV];
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("encrypted vault", () => {
  it("round-trips documents and every version through encryption", async () => {
    const root = await tempDir();
    const storage = new NestStorage(root);
    await storage.init("enc");
    const { passphrase } = await encryptVault(storage, { scrypt: FAST });
    expect(passphrase).toMatch(/^([0-9A-Z]{4}-){5}[0-9A-Z]{4}$/);

    await seedHistory(storage);

    // A fresh storage (as a new CLI process / MCP server would) reads plaintext.
    const fresh = new NestStorage(root);
    const doc = await fresh.readDocument("nodes/plan");
    expect(doc.frontmatter.title).toBe(TITLE);
    expect(doc.body).toContain(SECRET_V2);
    const vm = new VersionManager(fresh);
    expect(await vm.reconstructVersion("nodes/plan", 1)).toContain(SECRET);
    expect(await vm.reconstructVersion("nodes/plan", 1)).not.toContain(SECRET_V2);
    expect(await vm.reconstructVersion("nodes/plan", 2)).toContain(SECRET_V2);
    const history = await fresh.readHistory("nodes/plan");
    expect(history?.versions.map((v) => v.note)).toEqual(["first", "NOTE-TOKEN-second", undefined]);
    // Every history read decrypts: nothing may mistake a sealed history for an
    // unreadable one and restart the chain.
    expect(history?.versions.some((v) => /Chain restarted/.test(v.note ?? ""))).toBe(false);
    expect(history?.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await fresh.discoverDocuments()).map((d) => d.id)).toEqual(["nodes/plan"]);
    expect((await fresh.verifyVaultIntegrity()).valid).toBe(true);
  });

  it("leaves no plaintext body, keyframe, diff or note on disk", async () => {
    const root = await tempDir();
    const storage = new NestStorage(root);
    await storage.init("enc");
    await encryptVault(storage, { scrypt: FAST });
    await seedHistory(storage);

    expect(await filesContaining(root, SECRET)).toEqual([]);
    expect(await filesContaining(root, SECRET_V2)).toEqual([]);
    expect(await filesContaining(root, "NOTE-TOKEN-second")).toEqual([]); // history note
    // Front matter stays plaintext by design (indexing) — the title is visible.
    const onDisk = await readFile(join(root, "nodes", "plan.md"), "utf-8");
    expect(onDisk).toContain(`title: ${TITLE}`);
    expect(isArmoredText(onDisk)).toBe(true);
    expect(await storage.findUnencryptedFiles()).toEqual([]);
  });

  it("verify gives identical results for a plain and an encrypted copy of the same history", async () => {
    const plainRoot = await tempDir();
    const plain = new NestStorage(plainRoot);
    await plain.init("parity");
    await seedHistory(plain);

    const encRoot = await tempDir();
    await cp(plainRoot, encRoot, { recursive: true });
    const enc = new NestStorage(encRoot);
    await encryptVault(enc, { scrypt: FAST });

    // Hashes are defined over the plaintext: the histories match exactly.
    const hPlain = await plain.readHistory("nodes/plan");
    const hEnc = await new NestStorage(encRoot).readHistory("nodes/plan");
    expect(hEnc?.versions.map((v) => [v.content_hash, v.chain_hash])).toEqual(
      hPlain?.versions.map((v) => [v.content_hash, v.chain_hash]),
    );
    const rPlain = await plain.verifyVaultIntegrity();
    const rEnc = await new NestStorage(encRoot).verifyVaultIntegrity();
    expect(rPlain).toEqual({ valid: true, errors: [] });
    expect(rEnc).toEqual(rPlain);
    expect(await filesContaining(encRoot, SECRET)).toEqual([]);
  });

  it("without the key: reads refuse, verify reports 'key required' and never passes", async () => {
    const root = await tempDir();
    const storage = new NestStorage(root);
    await storage.init("enc");
    await encryptVault(storage, { scrypt: FAST });
    await seedHistory(storage);

    const locked = new NestStorage(root, { encryption: { keyStore: new MemoryKeyStore() } });
    await expect(locked.readDocument("nodes/plan")).rejects.toBeInstanceOf(VaultLockedError);
    await expect(locked.discoverDocuments()).rejects.toBeInstanceOf(VaultLockedError);
    const report = await locked.verifyVaultIntegrity();
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatchObject({ type: "encrypted_key_required" });
    expect(report.errors[0].actual).toMatch(/encrypted, key required/);
    // Chain linkage still verifies, so the ONLY finding is the missing key.
    expect(report.errors).toHaveLength(1);
  });

  it("a wrong key is rejected, and the recovery passphrase unlocks", async () => {
    const root = await tempDir();
    const storage = new NestStorage(root);
    await storage.init("enc");
    const { passphrase } = await encryptVault(storage, { scrypt: FAST });
    await seedHistory(storage);

    const wrong = new NestStorage(root, { encryption: { kek: Buffer.alloc(32, 7) } });
    await expect(wrong.readDocument("nodes/plan")).rejects.toBeInstanceOf(WrongVaultKeyError);
    const report = await wrong.verifyVaultIntegrity();
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatchObject({ type: "encrypted_key_required" });

    process.env[VAULT_PASSPHRASE_ENV] = "WRONG-PASS-PHRASE-0000";
    await expect(
      new NestStorage(root, { encryption: { keyStore: new MemoryKeyStore() } }).readDocument("nodes/plan"),
    ).rejects.toBeInstanceOf(WrongVaultKeyError);

    process.env[VAULT_PASSPHRASE_ENV] = passphrase!;
    const recovered = new NestStorage(root, { encryption: { keyStore: new MemoryKeyStore() } });
    expect((await recovered.readDocument("nodes/plan")).body).toContain(SECRET);
  });

  it("detects tampering: GCM rejects altered ciphertext and altered front matter", async () => {
    const root = await tempDir();
    const storage = new NestStorage(root);
    await storage.init("enc");
    await encryptVault(storage, { scrypt: FAST });
    await seedHistory(storage);

    // Flip one base64 character inside the v1 keyframe's ciphertext.
    const kf = join(root, "nodes", ".versions", "plan", "v1.md");
    const sealed = await readFile(kf, "utf-8");
    const lines = sealed.split("\n");
    const i = lines.findIndex((l) => l.startsWith("cn1 ")) + 1;
    lines[i] = (lines[i][0] === "A" ? "B" : "A") + lines[i].slice(1);
    await writeFile(kf, lines.join("\n"));
    const report = await new NestStorage(root).verifyVaultIntegrity();
    expect(report.valid).toBe(false);
    expect(report.errors).toContainEqual(
      expect.objectContaining({ type: "decryption_failed", document: "nodes/plan", version: 1 }),
    );

    // Editing the plaintext front matter projection breaks the document too.
    const live = join(root, "nodes", "plan.md");
    await writeFile(live, (await readFile(live, "utf-8")).replace(`title: ${TITLE}`, "title: Hijacked"));
    await expect(new NestStorage(root).readDocument("nodes/plan")).rejects.toBeInstanceOf(DecryptionFailedError);
  });

  it("migrates an existing vault in place and back, restoring the exact bytes", async () => {
    const root = await tempDir();
    const plain = new NestStorage(root);
    await plain.init("mig");
    await seedHistory(plain);
    const before = new Map<string, Buffer>();
    for (const f of await allFiles(root)) if (/\.(md|diff)$/.test(f)) before.set(f, await readFile(f));

    const storage = new NestStorage(root);
    const result = await encryptVault(storage, { scrypt: FAST });
    expect(result.sealed).toBeGreaterThanOrEqual(4); // live doc + v1.md + v2.diff + v3.diff
    expect(await filesContaining(root, SECRET)).toEqual([]);
    expect((await new NestStorage(root).verifyVaultIntegrity()).valid).toBe(true);

    // Resuming is a no-op on an already-encrypted vault.
    expect((await encryptVault(new NestStorage(root))).sealed).toBe(0);

    await decryptVault(new NestStorage(root));
    for (const [f, bytes] of before) {
      if (f.endsWith("INDEX.md") || f.endsWith("CLAUDE.md") || f.endsWith("AGENTS.md") || f.endsWith("GEMINI.md")) continue;
      expect((await readFile(f)).equals(bytes), f).toBe(true);
    }
    const back = new NestStorage(root);
    expect(await back.isEncrypted()).toBe(false);
    expect((await back.verifyVaultIntegrity()).valid).toBe(true);
    expect(await store.get(kekAccount(result.vaultId))).toBeNull();
  });

  it("does not mistake a plaintext note that quotes the armor for ciphertext", () => {
    const doc =
      "---\ntitle: Format notes\n---\n-----BEGIN CONTEXTNEST ENCRYPTED-----\ncn1 doc abc AAAA AAAA\nAAAA\n-----END CONTEXTNEST ENCRYPTED-----\n";
    expect(isArmoredText(doc)).toBe(false);
  });

  it("leaves default vaults plain", async () => {
    const root = await tempDir();
    const storage = new NestStorage(root);
    await storage.init("plain");
    await seedHistory(storage);
    expect(await storage.isEncrypted()).toBe(false);
    expect((await filesContaining(root, SECRET)).length).toBeGreaterThan(0);
    const h = await storage.readHistory("nodes/plan");
    expect(h?.versions.map((v) => v.note)).toEqual(["first", "NOTE-TOKEN-second", undefined]);
  });
});
