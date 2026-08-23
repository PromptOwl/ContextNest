/**
 * Tier 2 — the probe that exposed silent chain corruption, promoted to a test.
 *
 * Before the vault write lock: 6 concurrent `ctx update` processes on one
 * vault landed every body, but the nest-level checkpoint chain lost seals and
 * `ctx verify` reported `cross_chain_mismatch` — the integrity guarantee
 * breaking with no error anywhere. Parallel curator agents make this the
 * common case, so it is pinned here against the BUILT CLI (separate processes,
 * exactly the contention the lock exists for).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const WRITERS = 6;

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-conc-cfg-"));
let vaultDir: string;

const baseEnv = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;

function ctl(args: string[]): string {
  return execFileSync("node", [distPath, ...args], {
    cwd: vaultDir,
    env: baseEnv,
    encoding: "utf-8",
  });
}

beforeAll(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "cn-conc-vault-"));
  ctl(["init", "--name", "conc", "--description", "concurrency regression"]);
  for (let i = 1; i <= WRITERS; i++) {
    ctl(["add", `nodes/n${i}`, "--title", `N${i}`, "--tags", "t", "--body", `value is Redis (${i})`]);
  }
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("[regression] concurrent same-vault writes keep the chain intact", () => {
  it(`${WRITERS} parallel ctx update processes lose no checkpoint seals and verify clean`, async () => {
    const before = JSON.parse(ctl(["checkpoint", "list", "--json", "-n", "1"]))[0].checkpoint;

    // Genuinely concurrent OS processes — the shape parallel agents produce.
    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        execFileP(
          "node",
          [distPath, "update", `nodes/n${i + 1}`, "--body", `value is Postgres (${i + 1})`, "--yes"],
          { cwd: vaultDir, env: baseEnv },
        ),
      ),
    );

    // Every update landed…
    for (let i = 1; i <= WRITERS; i++) {
      expect(ctl(["read", `nodes/n${i}`, "--raw"])).toContain(`Postgres (${i})`);
    }

    // …every seal was recorded (pre-lock this lost seals silently)…
    const after = JSON.parse(ctl(["checkpoint", "list", "--json", "-n", "1"]))[0].checkpoint;
    expect(after).toBe(before + WRITERS);

    // …and the hash chain survived (pre-lock: cross_chain_mismatch).
    expect(ctl(["verify"])).toMatch(/All integrity checks passed/);
  }, 120_000);
});
