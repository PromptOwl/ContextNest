/**
 * Tier 2 — integration. The curator prompt (plugins/shared/prompts/curate.md)
 * tells an agent to sweep a vault a particular way and then apply the change
 * set behind a checkpoint. That recipe rests on claims about how the real CLI
 * behaves, and a prompt cannot assert anything — so this suite asserts the
 * claims instead, against a REAL vault built with the compiled CLI.
 *
 * If any of these flip (search starts including drafts, `--status draft` stops
 * listing them, `update --body` starts merging instead of replacing), the
 * prompt silently becomes wrong. That is what this exists to catch.
 *
 * Gated behind `pnpm test:regression`, which builds the CLI first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "packages", "cli", "dist", "index.js");

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-plugin-cur-cfg-"));
const baseEnv = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;

function ctl(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], { cwd, env: baseEnv, encoding: "utf-8" });
}
const json = (cwd: string, args: string[]) => JSON.parse(ctl(cwd, args));

/** The stale fact, planted in several places the way a real vault accumulates it. */
const OLD = "Redis";
const NEW = "Postgres";

let vaultDir: string;

beforeAll(() => {
  vaultDir = mkdtempSync(join(tmpdir(), "cn-plugin-cur-"));
  mkdirSync(vaultDir, { recursive: true });
  ctl(vaultDir, ["init", "--name", "curation", "--description", "storage and infrastructure"]);

  // Three published nodes all asserting the same thing, plus one draft — the
  // shape that makes a first-hit-only fix leave the vault self-contradictory.
  ctl(vaultDir, ["add", "nodes/session-store", "--title", "Session Store", "--tags", "infra", "--body", `Sessions live in ${OLD}.`]);
  ctl(vaultDir, ["add", "nodes/rate-limits", "--title", "Rate Limits", "--tags", "infra", "--body", `Counters are kept in ${OLD}.`]);
  ctl(vaultDir, ["add", "nodes/runbook", "--title", "Ops Runbook", "--tags", "infra", "--body", `Restart ${OLD} before the API.`]);
  // `ctx add` always publishes v1, so the draft is made by a follow-up update.
  ctl(vaultDir, ["add", "nodes/draft-plan", "--title", "Migration Plan", "--tags", "infra", "--body", `Move off ${OLD} next quarter.`]);
  ctl(vaultDir, ["update", "nodes/draft-plan", "--status", "draft", "--yes"]);
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

describe("[regression] the sweep recipe's premises hold against a real vault", () => {
  it("search finds the published occurrences but cannot see the draft", () => {
    const hits = json(vaultDir, ["search", OLD, "--json"]).map((h: any) => h.id);
    expect(hits).toEqual(expect.arrayContaining(["nodes/session-store", "nodes/rate-limits"]));
    // This is precisely why curate.md tells the agent that search is a starting
    // point and never proof, and to also list drafts.
    expect(hits).not.toContain("nodes/draft-plan");
  });

  it("listing drafts reaches what search cannot", () => {
    const drafts = json(vaultDir, ["list", "--status", "draft", "--json"]).map((d: any) => d.id);
    expect(drafts).toContain("nodes/draft-plan");
  });

  it("read --raw returns the body the agent has to diff against", () => {
    expect(ctl(vaultDir, ["read", "nodes/runbook", "--raw"])).toContain(`Restart ${OLD}`);
  });

  it("a multi-node sweep leaves no node asserting the old value", () => {
    // The recipe's before-marker. There is no `checkpoint create`: updates seal
    // checkpoints themselves, so what the agent records is the latest number.
    const before = json(vaultDir, ["checkpoint", "list", "--json", "-n", "1"]);
    expect(Array.isArray(before)).toBe(true);

    // The union of both discovery paths — what the recipe tells the agent to build.
    const published = json(vaultDir, ["search", OLD, "--json"]).map((h: any) => h.id);
    const drafts = json(vaultDir, ["list", "--status", "draft", "--json"]).map((d: any) => d.id);
    const candidates = [...new Set([...published, ...drafts])];

    let changed = 0;
    for (const id of candidates) {
      const raw = ctl(vaultDir, ["read", id, "--raw"]);
      const body = raw.replace(/^---[\s\S]*?\n---\n/, "");
      if (!body.includes(OLD)) continue;
      // read-modify-write: --body replaces the WHOLE body, so the agent must
      // carry forward everything it is not changing.
      ctl(vaultDir, ["update", id, "--body", body.split(OLD).join(NEW), "--yes"]);
      changed++;
    }
    expect(changed).toBeGreaterThanOrEqual(3);

    // The whole point: nothing is left behind still saying the old thing.
    for (const id of ["nodes/session-store", "nodes/rate-limits", "nodes/runbook", "nodes/draft-plan"]) {
      const raw = ctl(vaultDir, ["read", id, "--raw"]);
      expect(raw, `${id} still asserts ${OLD}`).not.toContain(OLD);
      expect(raw).toContain(NEW);
    }

    // And the sweep is unwindable: the boundary moved, so `ctx reconstruct` can
    // still hand back what any of these nodes said before it ran.
    const after = json(vaultDir, ["checkpoint", "list", "--json", "-n", "1"]);
    expect(after[0]?.checkpoint).toBeGreaterThan(before[0]?.checkpoint ?? 0);
    const history = json(vaultDir, ["history", "nodes/runbook", "--json"]);
    expect(history.versions?.length ?? history.length).toBeGreaterThan(1);
  });
});
