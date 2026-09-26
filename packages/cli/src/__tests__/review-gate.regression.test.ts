/**
 * [regression] The review gate through the built CLI, non-interactively (the
 * way agents and CI run it). The TTY [y]/[n]/[a] branches are unit-tested in
 * review-gate.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-review-cfg-"));
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;

const ctx = (cwd: string, args: string[]) =>
  execFileSync("node", [distPath, ...args], { cwd, env: ENV, encoding: "utf-8" });

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cn-review-"));
  ctx(tmp, ["init", "--name", "review-vault", "--layout", "structured"]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const doc = (id: string) => readFileSync(join(tmp, `${id}.md`), "utf-8");
const hasHistory = (id: string) =>
  existsSync(join(tmp, dirname(id), ".versions", id.split("/").pop()!, "history.yaml"));

describe("[regression] review gate — CLI", () => {
  it("a new vault has review on", () => {
    expect(ctx(tmp, ["config", "get", "review"]).trim()).toBe("on");
  });

  it("ctx add is held without blocking: one-line notice, pending_review, nothing sealed", () => {
    const out = ctx(tmp, ["add", "nodes/idea", "--title", "Idea"]);
    expect(out).toContain(
      "Held for review: ctx review approve nodes/idea   (turn off: ctx config set review off)",
    );
    expect(doc("nodes/idea")).toMatch(/status: pending_review/);
    expect(hasHistory("nodes/idea")).toBe(false);
  });

  it("ctx review approve publishes the held write", () => {
    ctx(tmp, ["add", "nodes/idea", "--title", "Idea"]);
    ctx(tmp, ["review", "approve", "nodes/idea"]);
    expect(doc("nodes/idea")).toMatch(/status: published/);
    expect(hasHistory("nodes/idea")).toBe(true);
  });

  it("--publish bypasses the gate for one write", () => {
    const out = ctx(tmp, ["add", "nodes/now", "--title", "Now", "--publish"]);
    expect(out).toMatch(/Created and published/);
    expect(doc("nodes/now")).toMatch(/status: published/);
  });

  it("ctx update of a published doc is staged; the published body keeps serving", () => {
    ctx(tmp, ["add", "nodes/pub", "--title", "Pub", "--body", "original", "--publish"]);
    const out = ctx(tmp, ["update", "nodes/pub", "--body", "changed"]);
    expect(out).toContain("Held for review: ctx review approve nodes/pub");
    expect(doc("nodes/pub")).toContain("original");
    ctx(tmp, ["review", "approve", "nodes/pub"]);
    expect(doc("nodes/pub")).toContain("changed");
  });

  it("ctx config set review off: writes publish immediately", () => {
    ctx(tmp, ["config", "set", "review", "off"]);
    expect(ctx(tmp, ["add", "nodes/free", "--title", "Free"])).toMatch(/Created and published/);
  });

  it("a vault from before the gate (no key) keeps publishing", () => {
    const cfg = join(tmp, ".context", "config.yaml");
    writeFileSync(cfg, readFileSync(cfg, "utf-8").replace(/^review:.*\n/m, ""));
    expect(ctx(tmp, ["config", "get", "review"]).trim()).toBe("unset");
    expect(ctx(tmp, ["add", "nodes/old", "--title", "Old"])).toMatch(/Created and published/);
  });
});
