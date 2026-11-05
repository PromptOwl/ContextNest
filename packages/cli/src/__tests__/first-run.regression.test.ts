import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "dist", "index.js");

let cfg: string;
beforeEach(() => {
  cfg = mkdtempSync(join(tmpdir(), "cn-firstrun-"));
});
afterEach(() => rmSync(cfg, { recursive: true, force: true }));

// stdin is not a TTY here, so these exercise the never-prompt paths.
function bare() {
  return spawnSync("node", [dist], {
    cwd: cfg,
    input: "",
    encoding: "utf-8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      HOME: cfg,
      CONTEXTNEST_CONFIG_DIR: cfg,
      CONTEXTNEST_NO_BROWSER: "1",
      NO_COLOR: "1",
    },
  });
}

describe("bare `ctx` (built CLI)", () => {
  it("first run without a terminal: help on stdout, exit 0, hint on stderr, nothing recorded", () => {
    const r = bare();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No notes yet/);
    expect(r.stdout).toMatch(/USAGE/);
    expect(r.stderr).toMatch(/terminal to get set up/);
    expect(() => readFileSync(join(cfg, "config.yaml"), "utf-8")).toThrow();
  });

  it("existing user (vault registered, no marker): plain help and silently marked onboarded", () => {
    writeFileSync(join(cfg, "config.yaml"), `version: 1\nvaults:\n  main:\n    path: ${cfg}\n`);
    const r = bare();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/No notes yet/);
    expect(r.stdout).toMatch(/USAGE/);
    expect(readFileSync(join(cfg, "config.yaml"), "utf-8")).toMatch(/onboarded_at/);
  });

  it("onboarded then all vaults removed: help with the no-notes line, no re-onboarding", () => {
    writeFileSync(join(cfg, "config.yaml"), "version: 1\nvaults: {}\nonboarded_at: '2026-01-01T00:00:00.000Z'\n");
    const r = bare();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No notes yet/);
    expect(r.stderr).toBe("");
  });
});
