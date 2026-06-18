/**
 * CLI tests for status alias normalization and the `ctx index` canonicalize pass.
 * Spawns the compiled CLI as a subprocess against an isolated vault.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

function runCtx(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], {
    cwd,
    env: { ...process.env, CONTEXTNEST_NO_BROWSER: "1" },
    encoding: "utf-8",
  });
}

function initVault(cwd: string) {
  execFileSync(
    "node",
    [distPath, "init", "--name", "status-vault", "--layout", "structured"],
    { cwd, env: { ...process.env, CONTEXTNEST_NO_BROWSER: "1" }, stdio: "ignore" },
  );
}

describe("ctx — status alias normalization", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-status-cli-"));
    initVault(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("`ctx index` canonicalizes aliased on-disk status values", () => {
    // Plant docs with aliased + unknown statuses.
    writeFileSync(
      join(tmp, "nodes", "alias-cancelled.md"),
      `---\ntitle: "Alias Cancelled"\nstatus: cancelled\n---\n\nBody\n`,
      "utf-8",
    );
    writeFileSync(
      join(tmp, "nodes", "alias-submitted.md"),
      `---\ntitle: "Alias Submitted"\nstatus: submitted\n---\n\nBody\n`,
      "utf-8",
    );
    writeFileSync(
      join(tmp, "nodes", "alias-superseded.md"),
      `---\ntitle: "Alias Superseded"\nstatus: superseded\n---\n\nBody\n`,
      "utf-8",
    );
    writeFileSync(
      join(tmp, "nodes", "alias-garbage.md"),
      `---\ntitle: "Garbage Status"\nstatus: garbage_value\n---\n\nBody\n`,
      "utf-8",
    );

    const stdout = runCtx(tmp, ["index"]);
    expect(stdout).toMatch(/Canonicalized status on \d+ document\(s\)/);

    expect(readFileSync(join(tmp, "nodes", "alias-cancelled.md"), "utf-8")).toMatch(
      /status:\s*rejected/,
    );
    expect(readFileSync(join(tmp, "nodes", "alias-submitted.md"), "utf-8")).toMatch(
      /status:\s*pending_review/,
    );
    expect(readFileSync(join(tmp, "nodes", "alias-superseded.md"), "utf-8")).toMatch(
      /status:\s*draft/,
    );
    expect(readFileSync(join(tmp, "nodes", "alias-garbage.md"), "utf-8")).toMatch(
      /status:\s*draft/,
    );
  });

  it("`ctx list --status cancelled` lists rejected docs (alias-aware filter)", () => {
    writeFileSync(
      join(tmp, "nodes", "retired-doc.md"),
      `---\ntitle: "Retired"\nstatus: rejected\n---\n\nBody\n`,
      "utf-8",
    );
    writeFileSync(
      join(tmp, "nodes", "live-doc.md"),
      `---\ntitle: "Live"\nstatus: published\n---\n\nBody\n`,
      "utf-8",
    );

    const stdout = runCtx(tmp, ["list", "--status", "cancelled", "--json"]);
    const parsed = JSON.parse(stdout);
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/retired-doc");
    expect(ids).not.toContain("nodes/live-doc");
  });

  it("`ctx list --status submitted` lists pending_review docs", () => {
    writeFileSync(
      join(tmp, "nodes", "review-doc.md"),
      `---\ntitle: "In Review"\nstatus: pending_review\n---\n\nBody\n`,
      "utf-8",
    );
    writeFileSync(
      join(tmp, "nodes", "draft-doc.md"),
      `---\ntitle: "Draft"\nstatus: draft\n---\n\nBody\n`,
      "utf-8",
    );

    const stdout = runCtx(tmp, ["list", "--status", "submitted", "--json"]);
    const parsed = JSON.parse(stdout);
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/review-doc");
    expect(ids).not.toContain("nodes/draft-doc");
  });

  it("`ctx list` (no filter) hides rejected docs by default", () => {
    writeFileSync(
      join(tmp, "nodes", "retired-default.md"),
      `---\ntitle: "Retired Default"\nstatus: rejected\n---\n\nBody\n`,
      "utf-8",
    );
    writeFileSync(
      join(tmp, "nodes", "draft-default.md"),
      `---\ntitle: "Draft Default"\nstatus: draft\n---\n\nBody\n`,
      "utf-8",
    );

    const stdout = runCtx(tmp, ["list", "--json"]);
    const parsed = JSON.parse(stdout);
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).not.toContain("nodes/retired-default");
    expect(ids).toContain("nodes/draft-default");
  });

  it("`ctx update --status submitted` lands as pending_review with no version cut", () => {
    // Seed a published doc with history.
    runCtx(tmp, ["add", "nodes/lifecycle-doc", "--title", "Lifecycle Doc"]);
    const beforePath = join(tmp, "nodes", "lifecycle-doc.md");
    const before = readFileSync(beforePath, "utf-8");
    expect(before).toMatch(/status:\s*published/);

    const stdout = runCtx(tmp, [
      "update",
      "nodes/lifecycle-doc",
      "--status",
      "submitted",
    ]);
    expect(stdout).toMatch(/submitted for review/);

    const after = readFileSync(beforePath, "utf-8");
    expect(after).toMatch(/status:\s*pending_review/);
  });

  it("`ctx update --status cancelled` retires the doc (status: rejected)", () => {
    runCtx(tmp, ["add", "nodes/retire-me", "--title", "Retire Me"]);
    const stdout = runCtx(tmp, ["update", "nodes/retire-me", "--status", "cancelled"]);
    expect(stdout).toMatch(/retired/);

    const onDisk = readFileSync(join(tmp, "nodes", "retire-me.md"), "utf-8");
    expect(onDisk).toMatch(/status:\s*rejected/);
  });
});
