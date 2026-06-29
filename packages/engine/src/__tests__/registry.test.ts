import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addVault,
  removeVault,
  setDefaultVault,
  listVaults,
  readRegistry,
  getRegistryDir,
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

  describe("readRegistry rejects corrupt config", () => {
    /** Write raw bytes to the (sandboxed) registry path, creating its dir. */
    function writeRawConfig(content: string): void {
      mkdirSync(getRegistryDir(), { recursive: true });
      writeFileSync(getRegistryPath(), content, "utf-8");
    }

    it("treats an empty / null document as an empty registry", () => {
      writeRawConfig("\n# just a comment\n");
      expect(readRegistry()).toEqual({ version: 1, vaults: {} });
    });

    it("throws ConfigError when the root is a scalar, not a mapping", () => {
      writeRawConfig("just a string\n");
      expect(() => readRegistry()).toThrow(ConfigError);
    });

    it("throws ConfigError when `vaults` is not a mapping", () => {
      writeRawConfig("version: 1\nvaults: 5\n");
      expect(() => readRegistry()).toThrow(ConfigError);
    });

    it("throws ConfigError on a hand-edited alias with illegal characters", () => {
      // Catching this on read is the point: a "my vault" key must not be silently
      // usable via CONTEXTNEST_VAULT, which would bypass the shell-safety invariant.
      writeRawConfig('version: 1\nvaults:\n  "my vault":\n    path: /tmp/v\n');
      expect(() => readRegistry()).toThrow(ConfigError);
    });

    it("throws ConfigError when an entry is missing its required path", () => {
      writeRawConfig("version: 1\nvaults:\n  a:\n    description: no path here\n");
      expect(() => readRegistry()).toThrow(ConfigError);
    });

    it("includes the registry path in the ConfigError message", () => {
      writeRawConfig("oops\n");
      expect(() => readRegistry()).toThrow(getRegistryPath());
    });
  });

  describe("writeRegistry atomic write", () => {
    it("leaves no temp file behind after a successful write", () => {
      const v = makeVault(join(tmp, "a"));
      addVault("a", v); // addVault → writeRegistry
      const entries = readdirSync(getRegistryDir());
      expect(entries).toContain("config.yaml");
      // The atomic-write temp is `config.yaml.<pid>.tmp`; none must linger.
      expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
    });

    it("round-trips the registry through disk unchanged", () => {
      const a = makeVault(join(tmp, "a"));
      const b = makeVault(join(tmp, "b"));
      addVault("a", a, { description: "first" });
      addVault("b", b, { setDefault: true });
      // Re-read from disk: a corrupt/truncated atomic write would fail to parse.
      const reg = readRegistry();
      expect(reg.default).toBe("b");
      expect(reg.vaults.a).toMatchObject({ path: a, description: "first" });
      expect(reg.vaults.b).toMatchObject({ path: b });
    });
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

    it("3c. a valid CONTEXTNEST_VAULT_PATH is honored even when unregistered", () => {
      // The path env var is a raw absolute path, not a registry lookup — an
      // unregistered-but-real vault must still resolve via env-path.
      const loose = makeVault(join(tmp, "loose-vault")); // a real vault, no alias
      process.env.CONTEXTNEST_VAULT_PATH = loose;
      const r = resolveVaultPath({ cwd: join(tmp, "anywhere") });
      expect(r).toMatchObject({ path: loose, source: "env-path" });
      expect(r.alias).toBeUndefined();
    });

    it("3d. CONTEXTNEST_VAULT_PATH outranks the positional arg", () => {
      // Precedence: env-path (step 3) sits above argPath (step 4).
      process.env.CONTEXTNEST_VAULT_PATH = beta;
      const r = resolveVaultPath({ argPath: "alpha", cwd: join(tmp, "x") });
      expect(r).toMatchObject({ path: beta, source: "env-path" });
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

    it("ignores a stale/unknown CONTEXTNEST_VAULT (does not throw) but carries the advisory", () => {
      // An explicit --vault throws, but the persistent env var must not lock the
      // user out: it falls through to the registry default. The advisory is
      // carried on the result so a diagnostic caller (ctx vault which) can show
      // it; normal commands decide whether to print it.
      process.env.CONTEXTNEST_VAULT = "ghost";
      const outside = join(tmp, "out-env");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: beta, source: "default", alias: "beta" });
      expect(r.warning).toMatch(/CONTEXTNEST_VAULT/);
    });

    it("carries the stale-CONTEXTNEST_VAULT advisory at the cwd fallback too", () => {
      removeVault("alpha");
      removeVault("beta"); // no default, no local vault below → cwd fallback
      process.env.CONTEXTNEST_VAULT = "ghost";
      const outside = join(tmp, "out-env-cwd");
      mkdirSync(outside, { recursive: true });
      const r = resolveVaultPath({ cwd: outside });
      expect(r).toMatchObject({ path: outside, source: "cwd" });
      expect(r.warning).toMatch(/CONTEXTNEST_VAULT/);
    });

    it("carries the advisory even when a local vault resolves (CLI suppresses the print)", () => {
      process.env.CONTEXTNEST_VAULT = "ghost";
      const nested = join(alpha, "nodes", "deep2");
      mkdirSync(nested, { recursive: true });
      const r = resolveVaultPath({ cwd: nested });
      expect(r).toMatchObject({ path: alpha, source: "local" });
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

    it("an explicit absolute argPath that isn't a vault throws (no silent fallthrough)", () => {
      // Regression: an explicit MCP arg pointing at a not-yet-mounted path must
      // not silently fall through to the registry default.
      const notYet = join(tmp, "not-a-vault");
      mkdirSync(notYet, { recursive: true });
      expect(() => resolveVaultPath({ argPath: notYet, cwd: join(tmp, "x") })).toThrow(
        /is not a vault/,
      );
    });

    it("argPath resolves a relative vault path against cwd (backward compat)", () => {
      // `contextnest-mcp ./vault` / `../vault` worked before the registry; a
      // relative, unregistered path must resolve against cwd, not throw.
      makeVault(join(tmp, "rel-vault"));
      const r = resolveVaultPath({ argPath: "rel-vault", cwd: tmp });
      expect(r).toMatchObject({ path: join(tmp, "rel-vault"), source: "arg" });
    });
  });
});
