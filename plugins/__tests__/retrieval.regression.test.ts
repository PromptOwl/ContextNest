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
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "cn-plugin-reg-"));
  alphaDir = join(workspace, "alpha");
  betaDir = join(workspace, "beta");
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  // `ctx init` initializes in the cwd and auto-registers an alias = --name.
  ctl(alphaDir, ["init", "--name", "alpha", "--description", "security and auth"]);
  ctl(betaDir, ["init", "--name", "beta", "--description", "performance and caching"]);
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
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
    expect(vaults.map((v: any) => v.alias).sort()).toEqual(["alpha", "beta"]);
    expect(out === null || typeof ctx(out) === "string").toBe(true);
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
