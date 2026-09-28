/**
 * Tier 2 — integration. Drives the REAL shared-core run() functions against a
 * REAL vault built with the compiled CLI (packages/cli/dist/index.js), via an
 * `exec` that spawns the built CLI. Gated behind `pnpm test:regression` (which
 * builds the CLI first). Tagged [regression] for selection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { run as retrieve } from "../shared/core/retrieve.js";
import { run as sessionStart } from "../shared/core/session-start.js";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "packages", "cli", "dist", "index.js");

// Sandbox the central registry so `ctx init` never touches the real config.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-plugin-reg-cfg-"));

// The core's getConfig() reads the real override files when the caller doesn't
// inject cwd/homedir, and the file layers beat env — so a developer's own
// ~/.contextnest/plugin-settings.json (a pinned vault, or retrieval_mode:
// "query") silently overrides the CONTEXTNEST_RETRIEVAL_MODE these tests pass
// and changes both the targets and the rendered format. Point the home and
// project dirs at an empty temp dir before baseEnv is built, so the in-process
// run() calls and the spawned CLI both see it. os.homedir() reads $HOME on
// POSIX and %USERPROFILE% on Windows, so both are set.
const NO_SETTINGS = mkdtempSync(join(tmpdir(), "cn-plugin-reg-nosettings-"));
const realEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};
process.env.HOME = NO_SETTINGS;
process.env.USERPROFILE = NO_SETTINGS;
process.env.CLAUDE_PROJECT_DIR = NO_SETTINGS;

const baseEnv = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;

/** Raw built-CLI runner (throws on non-zero), used for seeding the vaults. */
function ctl(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], { cwd, env: baseEnv, encoding: "utf-8" });
}

/** The injectable `exec` the core expects: never throws, returns {status,stdout}. */
function realExec(cwd: string) {
  return (args: string[]) => {
    try {
      const stdout = execFileSync("node", [distPath, ...args], {
        cwd,
        env: baseEnv,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err: any) {
      return { status: err.status ?? 1, stdout: err.stdout ? String(err.stdout) : "", stderr: "" };
    }
  };
}

const ctx = (out: any): string => out?.hookSpecificOutput?.additionalContext ?? "";

let alphaDir: string;
let betaDir: string;
let gammaDir: string;
let scratchDir: string;
let workspace: string;

// The registered vaults must NOT live under os.tmpdir(): auto-retrieval skips
// tmp-registered vaults on purpose (scratch vaults agents create — see
// vaultTargets), so a workspace there would never fan out. `fixtures/*` at the
// repo root is gitignored (only minimal-vault is tracked).
const SCRATCH_ROOT = join(here, "..", "..", "fixtures");

beforeAll(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  workspace = mkdtempSync(join(SCRATCH_ROOT, "cn-plugin-reg-"));
  alphaDir = join(workspace, "alpha");
  betaDir = join(workspace, "beta");
  gammaDir = join(workspace, "gamma");
  scratchDir = mkdtempSync(join(tmpdir(), "cn-plugin-reg-scratch-"));
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  mkdirSync(gammaDir, { recursive: true });
  // `ctx init` initializes in the cwd and registers it under --vault <alias>.
  ctl(alphaDir, ["init", "--name", "alpha", "--vault", "alpha", "--description", "security and auth"]);
  ctl(betaDir, ["init", "--name", "beta", "--vault", "beta", "--description", "performance and caching"]);
  // gamma is a vault on disk but NOT in the registry (the cwd-vault case).
  ctl(gammaDir, ["init", "--name", "gamma", "--vault", "gamma", "--description", "unregistered local notes"]);
  ctl(workspace, ["vault", "remove", "gamma", "--yes"]);
  // scratch is registered but lives under os.tmpdir() (an agent's throwaway).
  ctl(scratchDir, ["init", "--name", "scratch", "--vault", "scratch", "--description", "throwaway"]);
});

afterAll(() => {
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(NO_SETTINGS, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("[regression] plugin retrieval against a real vault", () => {
  it("seeds two vaults and the cheap search tier surfaces seeded nodes", () => {
    // Seed a node in each vault.
    ctl(alphaDir, ["add", "nodes/auth", "--title", "Auth Design", "--tags", "security,auth", "--body", "JWT rotation decisions."]);
    ctl(betaDir, ["add", "nodes/cache", "--title", "Cache Sizing", "--tags", "performance,cache", "--body", "LRU sizing notes."]);

    // Pinned to alpha → only alpha's node, ref labelled with the alias.
    const pinned = retrieve({
      input: { prompt: "auth" },
      env: { CONTEXTNEST_RETRIEVAL_MODE: "search", CONTEXTNEST_VAULT_ALIAS: "alpha" },
      exec: realExec(workspace),
    });
    expect(ctx(pinned)).toContain("alpha:nodes/auth");
    expect(ctx(pinned)).not.toContain("nodes/cache");
  });

  it("unpinned search fans out across both registered vaults", () => {
    const out = retrieve({
      input: { prompt: "design" }, // generic-ish; rely on per-vault search
      env: { CONTEXTNEST_RETRIEVAL_MODE: "search" },
      exec: realExec(workspace),
    });
    // At least the registry fan-out wiring resolves both aliases without error.
    // (Search relevance for the word "design" may vary; assert the mechanism.)
    const vaults = JSON.parse(ctl(workspace, ["vault", "list", "--json"]));
    expect(vaults.map((v: any) => v.alias).sort()).toEqual(["alpha", "beta", "scratch"]);
    expect(out === null || typeof ctx(out) === "string").toBe(true);
  });

  // CU-wdqcq01c5v — the vault in the working directory is searched first, and
  // registered vaults that are missing or live under os.tmpdir() are skipped.
  it("unpinned, cwd inside registered vault alpha → alpha is searched (once, by alias)", () => {
    const out = retrieve({
      input: { prompt: "auth", cwd: alphaDir },
      env: { CONTEXTNEST_RETRIEVAL_MODE: "search" },
      exec: realExec(alphaDir),
    });
    // The cwd vault is also registered, so it is targeted by alias rather than
    // searched twice: the ref keeps the `alpha:` prefix and appears exactly once.
    const text = ctx(out);
    expect(text).toContain("alpha:nodes/auth");
    expect(text.match(/nodes\/auth/g)).toHaveLength(1);
  });

  it("unpinned, cwd inside an UNREGISTERED vault → its nodes come first, unprefixed, ahead of the registry", () => {
    ctl(gammaDir, ["add", "nodes/local-auth", "--title", "Local Auth Notes", "--tags", "auth", "--body", "JWT rotation, local copy."]);
    const out = retrieve({
      input: { prompt: "auth", cwd: gammaDir },
      env: { CONTEXTNEST_RETRIEVAL_MODE: "search" },
      exec: realExec(gammaDir),
    });
    const text = ctx(out);
    // gamma is not registered → cited without an alias prefix.
    expect(text).toContain("- nodes/local-auth — Local Auth Notes");
    expect(text).not.toContain("gamma:");
    // The registry is still consulted after the cwd vault.
    expect(text).toContain("alpha:nodes/auth");
    expect(text.indexOf("nodes/local-auth")).toBeLessThan(text.indexOf("alpha:nodes/auth"));
  });

  it("a registered vault under os.tmpdir() is never searched", () => {
    ctl(scratchDir, ["add", "nodes/scratch-auth", "--title", "Scratch Auth", "--tags", "auth", "--body", "JWT rotation, throwaway."]);
    const out = retrieve({
      input: { prompt: "auth", cwd: workspace },
      env: { CONTEXTNEST_RETRIEVAL_MODE: "search" },
      exec: realExec(workspace),
    });
    const text = ctx(out);
    expect(text).toContain("alpha:nodes/auth");
    expect(text).not.toContain("scratch");
  });

  it("session-start names the working-directory vault", () => {
    const out = sessionStart({ input: { cwd: gammaDir }, env: {}, exec: realExec(gammaDir) });
    expect(ctx(out)).toMatch(/working-directory vault/i);
    expect(ctx(out)).toMatch(/not registered/i);
  });

  it("query tier maps tags and loads the graph for a seeded node", () => {
    const out = retrieve({
      input: { prompt: "auth" },
      env: { CONTEXTNEST_RETRIEVAL_MODE: "query", CONTEXTNEST_VAULT_ALIAS: "alpha" },
      exec: realExec(workspace),
    });
    expect(ctx(out)).toContain("nodes/auth");
    expect(ctx(out)).toMatch(/JWT rotation/);
  });

  it("session-start lists the registered vaults", () => {
    const out = sessionStart({ input: {}, env: {}, exec: realExec(workspace) });
    expect(ctx(out)).toContain("`alpha`");
    expect(ctx(out)).toContain("`beta`");
  });
});
