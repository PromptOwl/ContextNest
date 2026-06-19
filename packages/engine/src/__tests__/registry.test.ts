import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addVault,
  removeVault,
  setDefaultVault,
  listVaults,
  readRegistry,
  getRegistryPath,
  resolveVaultPath,
} from "../registry.js";
import { ConfigError } from "../errors.js";

/** Create a directory that looks like a vault (has .context/config.yaml). */
function makeVault(root: string, name = "Test Vault"): string {
  mkdirSync(join(root, ".context"), { recursive: true });
  writeFileSync(join(root, ".context", "config.yaml"), `version: 1\nname: "${name}"\n`);
  return root;
}

describe("vault registry", () => {
  let tmp: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-reg-"));
    savedEnv = {
      CONTEXTNEST_CONFIG_DIR: process.env.CONTEXTNEST_CONFIG_DIR,
      CONTEXTNEST_VAULT: process.env.CONTEXTNEST_VAULT,
      CONTEXTNEST_VAULT_PATH: process.env.CONTEXTNEST_VAULT_PATH,
    };
    // Sandbox the registry under the temp dir; clear ambient selectors.
    process.env.CONTEXTNEST_CONFIG_DIR = join(tmp, "cfg");
    delete process.env.CONTEXTNEST_VAULT;
    delete process.env.CONTEXTNEST_VAULT_PATH;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("starts empty and reports the sandboxed path", () => {
    expect(getRegistryPath()).toBe(join(tmp, "cfg", "config.yaml"));
    expect(readRegistry()).toEqual({ version: 1, vaults: {} });
    expect(listVaults()).toEqual([]);
  });

  it("adds a vault, making the first one the default", () => {
    const v = makeVault(join(tmp, "alpha"));
    addVault("alpha", v);
    const list = listVaults();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ alias: "alpha", path: v, isDefault: true, exists: true });
    // description falls back to the vault's own name
    expect(list[0].description).toBe("Test Vault");
  });

  it("rejects a non-vault path", () => {
    const notVault = join(tmp, "empty");
    mkdirSync(notVault, { recursive: true });
    expect(() => addVault("bad", notVault)).toThrow(ConfigError);
  });

  it("rejects a duplicate alias unless forced", () => {
    const a = makeVault(join(tmp, "a"));
    const b = makeVault(join(tmp, "b"));
    addVault("dup", a);
    expect(() => addVault("dup", b)).toThrow(/already exists/);
    addVault("dup", b, { force: true });
    expect(readRegistry().vaults.dup.path).toBe(b);
  });

  it("removes a vault and clears the default when it pointed there", () => {
    const a = makeVault(join(tmp, "a"));
    addVault("a", a);
    expect(readRegistry().default).toBe("a");
    removeVault("a");
    expect(readRegistry().vaults.a).toBeUndefined();
    expect(readRegistry().default).toBeUndefined();
    expect(() => removeVault("a")).toThrow(/No vault registered/);
  });

  it("sets the default vault", () => {
    addVault("a", makeVault(join(tmp, "a")));
    addVault("b", makeVault(join(tmp, "b")));
    expect(readRegistry().default).toBe("a"); // first wins
    setDefaultVault("b");
    expect(readRegistry().default).toBe("b");
    expect(() => setDefaultVault("nope")).toThrow(/No vault registered/);
  });

  describe("resolveVaultPath precedence", () => {
    let alpha: string;
    let beta: string;

    beforeEach(() => {
      alpha = makeVault(join(tmp, "alpha"));
      beta = makeVault(join(tmp, "beta"));
      addVault("alpha", alpha);
      addVault("beta", beta, { setDefault: true });
    });

    it("1. --vault flag wins over everything", () => {
      process.env.CONTEXTNEST_VAULT = "beta";
      process.env.CONTEXTNEST_VAULT_PATH = beta;
      const r = resolveVaultPath({ vaultAlias: "alpha", cwd: alpha });
      expect(r).toMatchObject({ path: alpha, source: "flag", alias: "alpha" });
    });

    it("2. CONTEXTNEST_VAULT alias beats env path and local", () => {
      process.env.CONTEXTNEST_VAULT = "alpha";
      process.env.CONTEXTNEST_VAULT_PATH = beta;
      const r = resolveVaultPath({ cwd: beta });
      expect(r).toMatchObject({ path: alpha, source: "env-alias", alias: "alpha" });
    });

    it("3. CONTEXTNEST_VAULT_PATH beats local and default", () => {
      const loose = join(tmp, "loose");
      const r = resolveVaultPath({ cwd: alpha });
      expect(r.source).toBe("local"); // sanity: no env yet
      process.env.CONTEXTNEST_VAULT_PATH = loose;
      const r2 = resolveVaultPath({ cwd: alpha });
      expect(r2).toMatchObject({ path: loose, source: "env-path" });
    });

    it("4. local vault (walk up) beats registry default", () => {
      const nested = join(alpha, "nodes", "deep");
      mkdirSync(nested, { recursive: true });
      const r = resolveVaultPath({ cwd: nested });
      expect(r).toMatchObject({ path: alpha, source: "local" });
    });

    it("5. registry default when nothing else matches", () => {
      const outside = join(tmp, "outside");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: beta, source: "default", alias: "beta" });
    });

    it("6. cwd fallback when no registry default", () => {
      removeVault("alpha");
      removeVault("beta");
      const outside = join(tmp, "outside2");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: outside, source: "cwd" });
    });

    it("throws on an unknown alias", () => {
      expect(() => resolveVaultPath({ vaultAlias: "ghost" })).toThrow(/Unknown vault alias/);
    });

    it("throws when a registered alias no longer points to a vault", () => {
      rmSync(join(alpha, ".context"), { recursive: true, force: true });
      expect(() => resolveVaultPath({ vaultAlias: "alpha" })).toThrow(/no longer a vault/);
    });
  });
});
