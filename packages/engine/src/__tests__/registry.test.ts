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

  it("rejects an alias with disallowed characters", () => {
    const v = makeVault(join(tmp, "v"));
    for (const bad of ["my vault", "a/b", "a:b", ""]) {
      expect(() => addVault(bad, v)).toThrow(ConfigError);
    }
    // a clean alias still works
    expect(() => addVault("my-vault_1", v)).not.toThrow();
  });

  it("rejects a relative vault path (must be absolute)", () => {
    // A relative path would resolve differently depending on the cwd at lookup.
    expect(() => addVault("rel", "some/relative/vault")).toThrow(/must be absolute/);
  });

  it("rejects a duplicate alias unless forced", () => {
    const a = makeVault(join(tmp, "a"));
    const b = makeVault(join(tmp, "b"));
    addVault("dup", a);
    expect(() => addVault("dup", b)).toThrow(/already exists/);
    addVault("dup", b, { force: true });
    expect(readRegistry().vaults.dup.path).toBe(b);
  });

  it("a --force overwrite does not grab the default when none is set", () => {
    const a = makeVault(join(tmp, "a"));
    const b = makeVault(join(tmp, "b"));
    addVault("one", a); // first → default
    addVault("two", b); // default stays "one"
    removeVault("one"); // default cleared
    expect(readRegistry().default).toBeUndefined();

    addVault("two", b, { force: true }); // overwrite existing → must NOT promote
    expect(readRegistry().default).toBeUndefined();

    const c = makeVault(join(tmp, "c"));
    addVault("three", c); // brand-new with no default → does promote
    expect(readRegistry().default).toBe("three");
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

    it("3. CONTEXTNEST_VAULT_PATH (a real vault) beats local and default", () => {
      expect(resolveVaultPath({ cwd: alpha }).source).toBe("local"); // sanity: no env yet
      process.env.CONTEXTNEST_VAULT_PATH = beta; // an actual vault root
      const r = resolveVaultPath({ cwd: alpha });
      expect(r).toMatchObject({ path: beta, source: "env-path" });
    });

    it("3b. a stale CONTEXTNEST_VAULT_PATH warns and falls through", () => {
      const loose = join(tmp, "loose"); // not a vault
      mkdirSync(loose, { recursive: true });
      process.env.CONTEXTNEST_VAULT_PATH = loose;
      const outside = join(tmp, "out-envpath");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      // falls through to the registry default; the advisory only surfaces at cwd
      expect(r).toMatchObject({ path: beta, source: "default", alias: "beta" });
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

    it("ignores a stale/unknown CONTEXTNEST_VAULT (does not throw), no warning when a vault resolves", () => {
      // An explicit --vault throws, but the persistent env var must not lock the
      // user out: it falls through to the registry default. Since a concrete
      // vault resolved, the advisory is suppressed (no per-command nag).
      process.env.CONTEXTNEST_VAULT = "ghost";
      const outside = join(tmp, "out-env");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: beta, source: "default", alias: "beta" });
      expect(r.warning).toBeUndefined();
    });

    it("surfaces the stale-CONTEXTNEST_VAULT warning only at the cwd fallback", () => {
      removeVault("alpha");
      removeVault("beta"); // no default, no local vault below → cwd fallback
      process.env.CONTEXTNEST_VAULT = "ghost";
      const outside = join(tmp, "out-env-cwd");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: outside, source: "cwd" });
      expect(r.warning).toMatch(/CONTEXTNEST_VAULT/);
    });

    it("throws when a registered alias no longer points to a vault", () => {
      rmSync(join(alpha, ".context"), { recursive: true, force: true });
      expect(() => resolveVaultPath({ vaultAlias: "alpha" })).toThrow(/no longer a vault/);
    });

    it("falls back to cwd (does not throw) when the default's vault is gone", () => {
      // A stale default must never lock the user out of the CLI. Unlike an
      // explicit --vault/env alias, the default is a soft fallback.
      setDefaultVault("beta");
      rmSync(join(beta, ".context"), { recursive: true, force: true });
      const outside = join(tmp, "outside-stale");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: outside, source: "cwd" });
    });

    // ── positional arg (MCP `contextnest-mcp <arg>`) ──────────────────────────
    it("argPath resolves a registered alias", () => {
      const r = resolveVaultPath({ argPath: "alpha", cwd: join(tmp, "x") });
      expect(r).toMatchObject({ path: alpha, source: "arg", alias: "alpha" });
    });

    it("argPath resolves an absolute vault path", () => {
      const r = resolveVaultPath({ argPath: beta, cwd: join(tmp, "x") });
      expect(r).toMatchObject({ path: beta, source: "arg" });
    });

    it("argPath is still honored when CONTEXTNEST_VAULT is stale", () => {
      // Regression: a stale env alias must not hide the positional arg.
      process.env.CONTEXTNEST_VAULT = "ghost";
      const r = resolveVaultPath({ argPath: "alpha", cwd: join(tmp, "x") });
      expect(r).toMatchObject({ path: alpha, source: "arg", alias: "alpha" });
    });

    it("argPath that is neither an alias nor an absolute path throws (typo guard)", () => {
      expect(() => resolveVaultPath({ argPath: "mytypo" })).toThrow(/not a registered vault alias/);
    });
  });
});
