/**
 * [regression] First-run friction through the built CLI: a document added
 * outside nodes/ must still be discoverable, and a search that only matches
 * held documents must say so instead of a bare "No results found."
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-onb-cfg-"));
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
  tmp = mkdtempSync(join(tmpdir(), "cn-onb-"));
  ctx(tmp, ["init", "--name", "onb-vault", "--layout", "structured"]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("[regression] onboarding hints — CLI", () => {
  it("ctx add outside nodes/ lands under nodes/, says so, and ctx list sees it", () => {
    const out = ctx(tmp, ["add", "notes/beta", "--title", "Beta"]);
    expect(out).toContain("nodes/notes/beta");
    expect(existsSync(join(tmp, "nodes", "notes", "beta.md"))).toBe(true);
    expect(existsSync(join(tmp, "notes", "beta.md"))).toBe(false);
    expect(ctx(tmp, ["list"])).toContain("nodes/notes/beta");
  });

  it("the held notice says the document is not searchable yet", () => {
    const out = ctx(tmp, ["add", "nodes/alpha", "--title", "Alpha", "--body", "zebra"]);
    expect(out).toContain("not visible to search or agents until approved");
  });

  it("ctx search names held matches instead of a bare empty result", () => {
    ctx(tmp, ["add", "nodes/alpha", "--title", "Alpha", "--body", "zebra policy"]);
    const out = ctx(tmp, ["search", "zebra"]);
    expect(out).toContain("1 matching document is held for review and not searchable until approved: ctx review list");
  });

  it("no held hint when search found published results", () => {
    ctx(tmp, ["add", "nodes/pub", "--title", "Pub", "--body", "zebra", "--publish"]);
    ctx(tmp, ["add", "nodes/held", "--title", "Held", "--body", "zebra"]);
    const out = ctx(tmp, ["search", "zebra"]);
    expect(out).toContain("nodes/pub");
    expect(out).not.toContain("held for review");
  });

  it("no held hint once the document is approved", () => {
    ctx(tmp, ["add", "nodes/alpha", "--title", "Alpha", "--body", "zebra policy"]);
    ctx(tmp, ["review", "approve", "nodes/alpha"]);
    const out = ctx(tmp, ["search", "zebra"]);
    expect(out).toContain("nodes/alpha");
    expect(out).not.toContain("held for review");
  });
});
