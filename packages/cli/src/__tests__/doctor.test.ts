import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const cliPkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
  version: string;
};
const enginePkg = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "engine", "package.json"), "utf-8"),
) as { version: string };

/**
 * Paths that round-trip through a child process's cwd come back canonical:
 * macOS reports /private/var for the /var tmpdir symlink, Windows may expand
 * an 8.3 short name. Compare on the realpath of both sides.
 */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

interface DoctorReport {
  cli: { version: string };
  engine: { version: string };
  latest: string | null;
  update_available: boolean | null;
  registry: {
    path: string;
    vaults: number;
    remotes: number;
    missing: number;
    missing_aliases: string[];
    default: string | null;
    default_missing: boolean;
  };
  cwd: { path: string; in_vault: boolean; vault_path: string | null; alias: string | null };
  plugin: { version: string | null; path: string | null };
}

/**
 * `ctx doctor` — one screen that would have caught months of version drift
 * (installed CLI 2.2.0 vs npm 2.4.0 vs plugin 0.1.0 vs 0.2.0) and a registry
 * whose default pointed at a deleted temp directory.
 */
describe("ctx doctor", () => {
  let tmp: string;
  let cfgDir: string;
  let claudeDir: string;

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CONTEXTNEST_NO_BROWSER: "1",
      CONTEXTNEST_CONFIG_DIR: cfgDir,
      CONTEXTNEST_VAULT: "",
      CONTEXTNEST_VAULT_PATH: "",
      // Never hit the network from the test suite unless a test opts in.
      CONTEXTNEST_DOCTOR_OFFLINE: "1",
      CLAUDE_CONFIG_DIR: claudeDir,
      ...extra,
    };
  }

  function run(args: string[], cwd: string, extra: Record<string, string> = {}): string {
    return execFileSync("node", [distPath, ...args], { cwd, env: env(extra), encoding: "utf-8" });
  }

  function runResult(args: string[], cwd: string, extra: Record<string, string> = {}) {
    const started = Date.now();
    const res = spawnSync("node", [distPath, ...args], { cwd, env: env(extra), encoding: "utf-8" });
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      elapsedMs: Date.now() - started,
    };
  }

  /** Registry with `a` (exists) and `b` (deleted), default `b`. */
  function seedRegistry(): { a: string; b: string } {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    run(["init", "--name", "A"], a);
    run(["init", "--name", "B"], b);
    run(["vault", "add", "a", a, "--force"], tmp);
    run(["vault", "add", "b", b, "--set-default", "--force"], tmp);
    rmSync(b, { recursive: true, force: true });
    return { a, b };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-cli-doctor-"));
    cfgDir = join(tmp, "cfg");
    claudeDir = join(tmp, "claude");
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--json offline: exits 0 within 4s with latest null, versions, and registry health", () => {
    const { a } = seedRegistry();
    const res = runResult(["doctor", "--json"], a);
    expect(res.status, res.stderr).toBe(0);
    expect(res.elapsedMs).toBeLessThan(4000);

    const report = JSON.parse(res.stdout) as DoctorReport;
    expect(report.cli.version).toBe(cliPkg.version);
    expect(report.engine.version).toBe(enginePkg.version);
    expect(report.latest).toBeNull();
    expect(report.update_available).toBeNull();

    expect(report.registry.path).toBe(join(cfgDir, "config.yaml"));
    expect(report.registry.vaults).toBe(2);
    expect(report.registry.missing).toBe(1);
    expect(report.registry.missing_aliases).toEqual(["b"]);
    expect(report.registry.default).toBe("b");
    expect(report.registry.default_missing).toBe(true);

    expect(report.cwd.in_vault).toBe(true);
    expect(real(report.cwd.vault_path ?? "")).toBe(real(a));
    expect(report.cwd.alias).toBe("a");

    // No plugin manifest under the sandboxed CLAUDE_CONFIG_DIR.
    expect(report.plugin.version).toBeNull();
  });

  it("reports the Claude Code plugin version from installed_plugins.json under CLAUDE_CONFIG_DIR", () => {
    mkdirSync(join(claudeDir, "plugins"), { recursive: true });
    writeFileSync(
      join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "other@marketplace": [{ version: "9.9.9" }],
          "contextnest@contextnest": [
            { scope: "user", installPath: "/x/contextnest/0.1.0", version: "0.1.0" },
          ],
        },
      }),
    );
    const report = JSON.parse(run(["doctor", "--json"], tmp)) as DoctorReport;
    expect(report.plugin.version).toBe("0.1.0");
    expect(report.plugin.path).toBe(join(claudeDir, "plugins", "installed_plugins.json"));
    // Outside any vault, with an empty registry.
    expect(report.cwd.in_vault).toBe(false);
    expect(report.registry.vaults).toBe(0);
    expect(report.registry.missing).toBe(0);
    expect(report.registry.default).toBeNull();
  });

  it("human output is a short table and always exits 0", () => {
    seedRegistry();
    const res = runResult(["doctor"], tmp);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain(cliPkg.version);
    expect(res.stdout).toContain(enginePkg.version);
    expect(res.stdout).toMatch(/missing/i);
    expect(res.stdout).toContain(join(cfgDir, "config.yaml"));
    expect(res.stdout).toMatch(/ctx vault prune/);
  });

  it("exits 0 with latest null even when the registry file is corrupt", () => {
    writeFileSync(join(cfgDir, "config.yaml"), "vaults: [not, a, map]\n");
    const res = runResult(["doctor", "--json"], tmp);
    expect(res.status, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout) as DoctorReport & { registry: { error?: string } };
    expect(report.registry.error).toBeTruthy();
    expect(report.latest).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "gives up on a hung `npm view` after ~3s and reports latest null",
    () => {
      // A stub `npm` first on PATH that never answers.
      const bin = join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "npm"), "#!/bin/sh\nsleep 30\n");
      chmodSync(join(bin, "npm"), 0o755);
      const res = runResult(["doctor", "--json"], tmp, {
        CONTEXTNEST_DOCTOR_OFFLINE: "",
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expect(res.status, res.stderr).toBe(0);
      // The probe gives up at 3s. The bound leaves room for Node's cold start
      // under a parallel test run (about 1s) while still proving the timer
      // fired rather than the 30s stub being waited out.
      expect(res.elapsedMs).toBeLessThan(6000);
      expect((JSON.parse(res.stdout) as DoctorReport).latest).toBeNull();
    },
  );
});
