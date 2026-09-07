import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

/**
 * `ctx vault prune` — registry hygiene. The observed failure: a registry whose
 * default pointed at a deleted temp scratchpad and four `[missing]` aliases,
 * with no command to clean it up short of hand-editing config.yaml.
 */
describe("ctx vault prune", () => {
  let tmp: string;
  let cfgDir: string;

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CONTEXTNEST_NO_BROWSER: "1",
      CONTEXTNEST_CONFIG_DIR: cfgDir,
      CONTEXTNEST_VAULT: "",
      CONTEXTNEST_VAULT_PATH: "",
      ...extra,
    };
  }

  function run(args: string[], cwd: string): string {
    return execFileSync("node", [distPath, ...args], { cwd, env: env(), encoding: "utf-8" });
  }

  function runResult(args: string[], cwd: string) {
    const res = spawnSync("node", [distPath, ...args], { cwd, env: env(), encoding: "utf-8" });
    return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  /** Registry with `a` (exists) and `b` (deleted), default `b`. */
  function seedRegistry(): { a: string; b: string } {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    run(["init", "--name", "A"], a);
    run(["init", "--name", "B"], b);
    // Explicit registration; --force keeps the seed independent of whether init
    // registered the alias itself.
    run(["vault", "add", "a", a, "--force"], tmp);
    run(["vault", "add", "b", b, "--set-default", "--force"], tmp);
    rmSync(b, { recursive: true, force: true });
    return { a, b };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-cli-prune-"));
    cfgDir = join(tmp, "cfg");
    mkdirSync(cfgDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("-y removes the missing alias, clears the default, and names both in the output", () => {
    const { a, b } = seedRegistry();
    const out = run(["vault", "prune", "-y"], tmp);
    expect(out).toContain("b");
    expect(out).toContain(b);
    expect(out).toMatch(/default/i);

    const list = JSON.parse(run(["vault", "list", "--json"], tmp)) as Array<{
      alias: string;
      path?: string;
      isDefault: boolean;
    }>;
    expect(list.map((v) => v.alias)).toEqual(["a"]);
    expect(list[0].path).toBe(a);
    expect(list[0].isDefault).toBe(false);

    const registry = readFileSync(join(cfgDir, "config.yaml"), "utf-8");
    expect(registry).not.toContain("b:");
    expect(registry).not.toMatch(/^default:/m);
  });

  it("--dry-run reports the same and leaves config.yaml byte-identical", () => {
    const { b } = seedRegistry();
    const before = readFileSync(join(cfgDir, "config.yaml"), "utf-8");
    const res = runResult(["vault", "prune", "--dry-run"], tmp);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("b");
    expect(res.stdout).toContain(b);
    expect(res.stdout).toMatch(/default/i);
    expect(readFileSync(join(cfgDir, "config.yaml"), "utf-8")).toBe(before);
  });

  it("is destructive: refuses without --yes when there is no TTY", () => {
    seedRegistry();
    const before = readFileSync(join(cfgDir, "config.yaml"), "utf-8");
    const res = runResult(["vault", "prune"], tmp);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Refusing without confirmation/);
    expect(readFileSync(join(cfgDir, "config.yaml"), "utf-8")).toBe(before);
  });

  it("leaves remotes alone and says so when nothing is missing", () => {
    const a = join(tmp, "a");
    mkdirSync(a, { recursive: true });
    run(["init", "--name", "A"], a);
    run(["vault", "add", "a", a, "--force"], tmp);
    run(["vault", "add", "far", "--url", "https://nest.example.com/mcp"], tmp);
    const before = readFileSync(join(cfgDir, "config.yaml"), "utf-8");

    const out = run(["vault", "prune", "-y"], tmp);
    expect(out).toMatch(/nothing to prune/i);
    expect(readFileSync(join(cfgDir, "config.yaml"), "utf-8")).toBe(before);
  });

  it("`vault list` hints at prune while the default alias is missing on disk", () => {
    seedRegistry();
    expect(run(["vault", "list"], tmp)).toContain("default vault is missing — run ctx vault prune");
    run(["vault", "prune", "-y"], tmp);
    expect(run(["vault", "list"], tmp)).not.toContain("default vault is missing");
  });
});
