import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

// A sandbox that is NOT under the OS temp dir, for the "outside tmp, behaviour
// unchanged" regression. Lives under the package (gitignored) and is removed
// after the suite.
const NON_TMP_ROOT = join(here, "..", "..", ".tmp-test");

function realpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function isUnderTmp(p: string): boolean {
  const t = realpath(tmpdir());
  const r = realpath(p);
  return r === t || r.startsWith(t + sep);
}

/**
 * `ctx init` auto-registered every vault, including ones created under the OS
 * temp dir by agents and test runs. Those paths vanish, so the registry filled
 * up with `[missing]` aliases and a default that pointed at a deleted
 * scratchpad. Under tmp, init now creates the vault but does not register it
 * unless asked.
 */
describe("ctx init — registration under the OS temp dir", () => {
  let tmp: string;
  let cfgDir: string;

  function run(args: string[], cwd: string): string {
    return execFileSync("node", [distPath, ...args], {
      cwd,
      env: {
        ...process.env,
        CONTEXTNEST_NO_BROWSER: "1",
        CONTEXTNEST_CONFIG_DIR: cfgDir,
        CONTEXTNEST_VAULT: "",
        CONTEXTNEST_VAULT_PATH: "",
      },
      encoding: "utf-8",
    });
  }

  function registryText(): string {
    const p = join(cfgDir, "config.yaml");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-init-reg-"));
    cfgDir = join(tmp, "cfg");
    mkdirSync(cfgDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(NON_TMP_ROOT, { recursive: true, force: true });
  });

  it("creates the vault but leaves the registry unchanged", () => {
    const dir = join(tmp, "scratch");
    mkdirSync(dir, { recursive: true });
    const before = registryText();

    const out = run(["init", "--name", "Scratch"], dir);

    expect(existsSync(join(dir, ".context", "config.yaml"))).toBe(true);
    expect(out).toContain("Not registering: vault is under the temp dir (pass --register to force)");
    expect(out).not.toContain("Registered vault");
    expect(registryText()).toBe(before);
    expect(registryText()).not.toContain("scratch");
  });

  it("--register forces registration under the temp dir", () => {
    const dir = join(tmp, "scratch");
    mkdirSync(dir, { recursive: true });

    const out = run(["init", "--name", "Scratch", "--register"], dir);

    expect(out).toContain("Registered vault");
    expect(out).not.toContain("Not registering");
    expect(registryText()).toContain("scratch");
    expect(registryText()).toContain(dir);
  });

  it("an explicit --vault <alias> is a registration request too", () => {
    const dir = join(tmp, "scratch");
    mkdirSync(dir, { recursive: true });
    run(["init", "--name", "Scratch", "--vault", "explicit"], dir);
    expect(registryText()).toContain("explicit:");
  });

  it("outside the temp dir, init still registers (regression)", (ctx) => {
    if (isUnderTmp(NON_TMP_ROOT)) {
      // The checkout itself lives under the temp dir; there is no non-tmp
      // location this test can safely create, so it cannot make its claim.
      ctx.skip();
      return;
    }
    mkdirSync(NON_TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(NON_TMP_ROOT, "init-"));
    try {
      const out = run(["init", "--name", "Real"], dir);
      expect(out).toContain("Registered vault");
      expect(out).not.toContain("Not registering");
      expect(registryText()).toContain(realpath(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
