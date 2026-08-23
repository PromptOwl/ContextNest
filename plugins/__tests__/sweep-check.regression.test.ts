/**
 * Tier 2 — the sweep-check hook against REAL vaults and the compiled CLI.
 *
 * The scenario is the bug report: a fact lives in several nodes across TWO
 * nests; an update lands in one node; everything else keeps asserting the old
 * value. The hook must name every survivor — including the one in the other
 * nest — and go silent once they are fixed.
 *
 * Gated behind `pnpm test:regression`, which builds the CLI first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { run as sweepCheck } from "../shared/core/sweep-check.js";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "packages", "cli", "dist", "index.js");

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-sweep-cfg-"));
const baseEnv = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;

let workspace: string;

function ctl(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], { cwd, env: baseEnv, encoding: "utf-8" });
}

/** The injectable exec the hook expects, running the real CLI. */
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

const OLD = "Blazefast";
const NEW = "Steadyrock";

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "cn-sweep-"));
  for (const [alias, desc] of [
    ["eng", "engineering internals"],
    ["mkt", "positioning and messaging"],
  ]) {
    const dir = join(workspace, alias);
    mkdirSync(dir, { recursive: true });
    ctl(dir, ["init", "--name", alias, "--description", desc]);
  }
  const eng = join(workspace, "eng");
  const mkt = join(workspace, "mkt");
  ctl(eng, ["add", "nodes/stack", "--title", "Stack", "--tags", "infra", "--body", `The queue engine is ${OLD}.`]);
  ctl(eng, ["add", "nodes/runbook", "--title", "Runbook", "--tags", "infra", "--body", `Restart ${OLD} before the API.`]);
  ctl(mkt, ["add", "nodes/pitch", "--title", "Pitch", "--tags", "messaging", "--body", `We highlight ${OLD} in demos.`]);
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe("[regression] sweep-check spans nests and converges", () => {
  it("after one update it names the survivors in BOTH nests, then goes silent", () => {
    const eng = join(workspace, "eng");
    ctl(eng, ["update", "nodes/stack", "--vault", "eng", "--body", `The queue engine is ${NEW}.`, "--yes"]);

    const exec = realExec(workspace);
    const input = {
      tool_input: { command: `ctx update nodes/stack --vault eng --body "The queue engine is ${NEW}." --yes` },
    };

    const first = sweepCheck({ input, env: {}, exec });
    const text = first?.hookSpecificOutput?.additionalContext ?? "";
    expect(first?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    // Same-nest sibling AND the other nest's node — the multi-nest guarantee.
    expect(text).toContain(`eng:nodes/runbook still contains "${OLD.toLowerCase()}"`);
    expect(text).toContain(`mkt:nodes/pitch still contains "${OLD.toLowerCase()}"`);
    // The written node itself is not reported.
    expect(text).not.toContain("eng:nodes/stack still contains");

    // Fix the survivors — the convergence half of the contract.
    ctl(eng, ["update", "nodes/runbook", "--vault", "eng", "--body", `Restart ${NEW} before the API.`, "--yes"]);
    ctl(join(workspace, "mkt"), ["update", "nodes/pitch", "--vault", "mkt", "--body", `We highlight ${NEW} in demos.`, "--yes"]);

    const second = sweepCheck({ input, env: {}, exec });
    // The written node's before/after diff still drops the old term, but no
    // node anywhere still contains it: silence.
    expect(second).toBeNull();
  });
});
