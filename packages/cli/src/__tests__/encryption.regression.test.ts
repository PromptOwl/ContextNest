/**
 * [regression] Encrypted vaults through the built CLI (spec: docs/encrypted-vaults.md).
 *
 * Each test spawns the compiled CLI against an isolated encrypted vault and
 * exercises the surfaces that must keep working when note content is sealed at
 * rest: init, the on-disk seal, the in-memory read/query/search round-trip,
 * verify, decrypt, and the degraded paths when the key is absent or wrong.
 *
 * Key isolation: `CONTEXTNEST_CREDENTIALS_BACKEND=file` (with no
 * CONTEXTNEST_CREDENTIALS_KEY) keeps the CLI off the OS keychain, so the KEK
 * lands in the engine's interim 0600 store under the sandboxed
 * CONTEXTNEST_CONFIG_DIR — deterministic, and never touching the real machine.
 * The three vault-key env vars are blanked so a key/passphrase in the ambient
 * shell can never make a "without the key" test unlock for the wrong reason.
 * Unit coverage of the crypto envelope lives in the engine's
 * encrypted-vault.test.ts; this pins the CLI wiring.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-enc-cfg-"));
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
  // Keep the CLI off the OS keychain so the KEK goes to the sandboxed interim
  // file store instead of the real machine's credential store.
  CONTEXTNEST_CREDENTIALS_BACKEND: "file",
  // Blank every unlock source (empty string is treated as unset by the CLI).
  // Otherwise an ambient key/passphrase would defeat the keyless tests, and the
  // interim-file-store premise above would silently break.
  CONTEXTNEST_VAULT_KEY: "",
  CONTEXTNEST_VAULT_PASSPHRASE: "",
  CONTEXTNEST_CREDENTIALS_KEY: "",
  CONTEXTNEST_AGENT: "",
  CONTEXTNEST_SESSION_ID: "",
} as NodeJS.ProcessEnv;

/** Run the CLI and return stdout. Throws on a non-zero exit. */
function runCtx(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): string {
  return execFileSync("node", [distPath, ...args], { cwd, env, encoding: "utf-8" });
}

/** Run tolerating failure, returning exit status plus captured stdout/stderr. */
function runCtxResult(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = ENV,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("node", [distPath, ...args], { cwd, env, encoding: "utf-8" });
  return {
    status: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const RECOVERY_PASSPHRASE = /([0-9A-Z]{4}-){5}[0-9A-Z]{4}/;

/**
 * Init an encrypted vault (review off) and return the recovery passphrase the
 * CLI prints once. Mirrors initVault in cli.regression.test.ts.
 */
function initEncryptedVault(cwd: string, env: NodeJS.ProcessEnv = ENV): { passphrase: string } {
  const out = execFileSync(
    "node",
    [distPath, "init", "--name", "enc-vault", "--layout", "structured", "--encrypted"],
    { cwd, env, encoding: "utf-8" },
  );
  execFileSync("node", [distPath, "config", "set", "review", "off"], { cwd, env, stdio: "ignore" });
  const passphrase = out.match(RECOVERY_PASSPHRASE)?.[0];
  if (!passphrase) throw new Error("init --encrypted did not print a recovery passphrase");
  return { passphrase };
}

/** Config dirs handed to keyless runs — tracked so afterAll can remove them. */
const keylessDirs: string[] = [];
afterAll(() => keylessDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A keyless environment: a fresh config dir holds no interim key file. */
function keylessEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "cn-enc-nokey-"));
  keylessDirs.push(dir);
  return { ...ENV, CONTEXTNEST_CONFIG_DIR: dir };
}

/** The interim key files a config dir holds (one per encrypted vault). */
const keyFiles = (configDir: string): string[] => {
  try {
    return readdirSync(join(configDir, "keys")).filter((f) => f.endsWith(".key"));
  } catch {
    return [];
  }
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cn-enc-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = "TOPSECRET-BODY-42";

describe("[regression] ctx init --encrypted", () => {
  it("creates an encrypted vault, prints a recovery passphrase, and sandboxes the key", () => {
    // A dedicated config dir so the key-file assertion reflects THIS init, not
    // a key some earlier test left in the shared store.
    const cfg = mkdtempSync(join(tmpdir(), "cn-enc-init-cfg-"));
    try {
      const env = { ...ENV, CONTEXTNEST_CONFIG_DIR: cfg };
      const out = runCtx(tmp, ["init", "--name", "enc-vault", "--layout", "structured", "--encrypted"], env);
      expect(out).toMatch(/ENCRYPTED VAULT/);
      expect(out).toMatch(RECOVERY_PASSPHRASE);
      expect(existsSync(join(tmp, ".context", "encryption.yaml"))).toBe(true);
      // The KEK lands in the sandboxed interim store as one key file — never the
      // real keychain.
      expect(keyFiles(cfg)).toHaveLength(1);
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});

describe("[regression] encrypted vault — seal, round-trip, verify", () => {
  beforeEach(() => initEncryptedVault(tmp));

  it("seals the body on disk but keeps front matter plaintext and indexable", () => {
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--tags", "#classified", "--body", SECRET]);
    const onDisk = readFileSync(join(tmp, "nodes", "secret.md"), "utf-8");
    // Body sealed: the plaintext secret is nowhere in the file...
    expect(onDisk).not.toContain(SECRET);
    // ...but front matter stays plaintext, with the encryption marker.
    expect(onDisk).toMatch(/title: My Secret/);
    expect(onDisk).toMatch(/contextnest_encrypted:/);
  });

  it("reads, resolves and searches through the key (decrypt happens in memory)", () => {
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--tags", "#classified", "--body", SECRET]);

    // read returns the decrypted body and title.
    const raw = runCtx(tmp, ["read", "nodes/secret", "--raw"]);
    expect(raw).toMatch(/title: My Secret/);
    expect(raw).toContain(SECRET);

    // resolve by (plaintext) tag finds it.
    const resolved = JSON.parse(runCtx(tmp, ["resolve", "#classified", "--json"])) as Array<{ id: string }>;
    expect(resolved.map((d) => d.id)).toEqual(["nodes/secret"]);

    // full-text search matches sealed body content, decrypting in memory.
    const found = JSON.parse(runCtx(tmp, ["search", SECRET, "--json"])) as Array<{ id: string }>;
    expect(found.map((d) => d.id)).toContain("nodes/secret");
  });

  it("an update seals the new body, and read/history/reconstruct return the plaintext chain", () => {
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);
    runCtx(tmp, ["update", "nodes/secret", "--body", `${SECRET}-v2`]);

    // read returns the current (v2) body; the sealed v1 keyframe is not on disk.
    expect(runCtx(tmp, ["read", "nodes/secret", "--raw"])).toContain(`${SECRET}-v2`);
    expect(readFileSync(join(tmp, "nodes", "secret.md"), "utf-8")).not.toContain(`${SECRET}-v2`);

    // history lists both versions; reconstruct rebuilds each plaintext from the
    // sealed keyframe+diff chain.
    const history = JSON.parse(runCtx(tmp, ["history", "nodes/secret", "--json"]));
    expect(history.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(runCtx(tmp, ["reconstruct", "nodes/secret", "1"])).toContain(SECRET);
    expect(runCtx(tmp, ["reconstruct", "nodes/secret", "1"])).not.toContain(`${SECRET}-v2`);
    expect(runCtx(tmp, ["reconstruct", "nodes/secret", "2"])).toContain(`${SECRET}-v2`);
  });

  it("verify passes on an encrypted vault when the key is available", () => {
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);
    runCtx(tmp, ["update", "nodes/secret", "--body", `${SECRET}-v2`]);
    const { status } = runCtxResult(tmp, ["verify"]);
    expect(status).toBe(0);
  });
});

describe("[regression] encrypted vault — read --html output guard", () => {
  beforeEach(() => {
    initEncryptedVault(tmp);
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);
  });

  it("read --html refuses without --out (would drop plaintext under .context)", () => {
    const { status, stderr } = runCtxResult(tmp, ["read", "nodes/secret", "--html"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/ENCRYPTED_VAULT/);
    expect(stderr).toMatch(/--out/);
  });

  it("read --html --out writes the chosen file", () => {
    const target = join(tmp, "out.html");
    const { status } = runCtxResult(tmp, ["read", "nodes/secret", "--html", "--out", target]);
    expect(status).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain(SECRET);
  });
});

describe("[regression] encrypted vault — decrypt back to plaintext", () => {
  it("vault decrypt restores plaintext, removes the key material, and still serves reads", () => {
    // A dedicated config dir so the key-file removal is observable in isolation.
    const cfg = mkdtempSync(join(tmpdir(), "cn-enc-dec-cfg-"));
    try {
      const env = { ...ENV, CONTEXTNEST_CONFIG_DIR: cfg };
      initEncryptedVault(tmp, env);
      runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET], env);
      expect(keyFiles(cfg)).toHaveLength(1);

      const out = runCtx(tmp, ["vault", "decrypt", "--yes"], env);
      expect(out).toMatch(/Decrypted \d+ file\(s\)/);
      // Plaintext on disk, encryption metadata and the interim key both gone.
      expect(readFileSync(join(tmp, "nodes", "secret.md"), "utf-8")).toContain(SECRET);
      expect(existsSync(join(tmp, ".context", "encryption.yaml"))).toBe(false);
      expect(keyFiles(cfg)).toHaveLength(0);
      // Still a well-formed, queryable plain vault afterwards.
      expect(runCtxResult(tmp, ["verify"], env).status).toBe(0);
      expect(runCtx(tmp, ["read", "nodes/secret", "--raw"], env)).toContain(SECRET);
      const found = JSON.parse(runCtx(tmp, ["search", SECRET, "--json"], env)) as Array<{ id: string }>;
      expect(found.map((d) => d.id)).toContain("nodes/secret");
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});

describe("[regression] encrypted vault — degrades safely without the key", () => {
  it("read without the key fails with a locked error that names how to unlock", () => {
    initEncryptedVault(tmp);
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);

    const { status, stderr } = runCtxResult(tmp, ["read", "nodes/secret"], keylessEnv());
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/VAULT_LOCKED/);
    expect(stderr).toMatch(/CONTEXTNEST_VAULT_KEY|CONTEXTNEST_VAULT_PASSPHRASE/);
    // No plaintext leaks in the error, and no raw stack trace.
    expect(stderr).not.toContain(SECRET);
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it("a keyless write is refused and never drops plaintext into the vault", () => {
    initEncryptedVault(tmp);
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);
    const env = keylessEnv();

    // A new document: the write fails and no plaintext .md is created.
    const added = runCtxResult(tmp, ["add", "nodes/leak", "--title", "Leak", "--body", SECRET], env);
    expect(added.status).not.toBe(0);
    expect(added.stderr).toMatch(/VAULT_LOCKED/);
    expect(existsSync(join(tmp, "nodes", "leak.md"))).toBe(false);

    // An existing sealed document is not overwritten with plaintext either.
    const updated = runCtxResult(tmp, ["update", "nodes/secret", "--body", `${SECRET}-leak`], env);
    expect(updated.status).not.toBe(0);
    expect(readFileSync(join(tmp, "nodes", "secret.md"), "utf-8")).not.toContain(`${SECRET}-leak`);
  });

  it("a wrong recovery passphrase is rejected, not silently accepted", () => {
    initEncryptedVault(tmp);
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);

    const env = { ...keylessEnv(), CONTEXTNEST_VAULT_PASSPHRASE: "WRON-GWRO-NGWR-ONGW-RONG-WRON" };
    const { status, stderr } = runCtxResult(tmp, ["read", "nodes/secret"], env);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/VAULT_KEY_MISMATCH/);
  });

  it("the recovery passphrase unlocks the vault on a machine without the key", () => {
    const { passphrase } = initEncryptedVault(tmp);
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);

    const env = { ...keylessEnv(), CONTEXTNEST_VAULT_PASSPHRASE: passphrase };
    const { status, stdout } = runCtxResult(tmp, ["read", "nodes/secret", "--raw"], env);
    expect(status).toBe(0);
    expect(stdout).toContain(SECRET);
  });

  it("verify without the key reports 'encrypted, key required' and never passes", () => {
    initEncryptedVault(tmp);
    runCtx(tmp, ["add", "nodes/secret", "--title", "My Secret", "--body", SECRET]);

    const { status, stdout, stderr } = runCtxResult(tmp, ["verify"], keylessEnv());
    expect(status).not.toBe(0);
    // The chain linkage still checks (history.yaml hashes are plaintext), but the
    // run is marked as needing the key and never reports a clean pass.
    expect(stdout).toMatch(/encrypted, key required/);
    expect(stdout).not.toMatch(/All integrity checks passed/);
    // Whichever channel carries the key-required signal, it stays friendly.
    expect(stderr).not.toMatch(/\n\s+at /);
    expect(stdout + stderr).not.toContain(SECRET);
  });
});
