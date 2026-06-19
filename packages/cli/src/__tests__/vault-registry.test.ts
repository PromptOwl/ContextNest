import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

describe("ctx vault — central registry", () => {
  let tmp: string;
  let cfgDir: string;

  function run(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
    return execFileSync("node", [distPath, ...args], {
      cwd,
      env: {
        ...process.env,
        CONTEXTNEST_NO_BROWSER: "1",
        CONTEXTNEST_CONFIG_DIR: cfgDir,
        // Clear ambient selectors so tests are deterministic.
        CONTEXTNEST_VAULT: "",
        CONTEXTNEST_VAULT_PATH: "",
        ...extraEnv,
      },
      encoding: "utf-8",
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-cli-reg-"));
    cfgDir = join(tmp, "cfg");
    mkdirSync(cfgDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("init --vault registers the new vault, and other dirs can target it", () => {
    const a = join(tmp, "a");
    mkdirSync(a, { recursive: true });
    run(["init", "--name", "AlphaVault", "--vault", "alpha"], a);

    // Registry file written under the sandboxed config dir.
    const registry = readFileSync(join(cfgDir, "config.yaml"), "utf-8");
    expect(registry).toContain("alpha");
    expect(registry).toMatch(/path:/);

    // From an unrelated directory, `vault which --vault alpha` resolves to a.
    const outside = join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    const which = run(["vault", "which", "--vault", "alpha"], outside);
    expect(which).toContain("source: flag");
  });

  it("uses the registry default from an unrelated directory", () => {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    run(["init", "--name", "A", "--vault", "alpha"], a);
    run(["init", "--name", "B", "--vault", "beta", "--set-default"], b);

    const outside = join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    const which = run(["vault", "which"], outside);
    expect(which).toContain("source: default");
    expect(which).toContain("alias: beta");
  });

  it("vault add / list / remove round-trip", () => {
    const a = join(tmp, "a");
    mkdirSync(a, { recursive: true });
    run(["init", "--name", "Standalone"], a); // no --vault: not registered yet

    run(["vault", "add", "work", a, "--description", "Work vault"], tmp);
    const list = run(["vault", "list"], tmp);
    expect(list).toContain("work");
    expect(list).toContain("Work vault");

    run(["vault", "remove", "work"], tmp);
    const listAfter = run(["vault", "list"], tmp);
    expect(listAfter).toContain("No vaults registered");
  });

  it("CONTEXTNEST_VAULT env selects a registered vault by alias", () => {
    const a = join(tmp, "a");
    mkdirSync(a, { recursive: true });
    run(["init", "--name", "A", "--vault", "alpha"], a);

    const outside = join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    const which = run(["vault", "which"], outside, { CONTEXTNEST_VAULT: "alpha" });
    expect(which).toContain("source: env-alias");
    expect(which).toContain("alias: alpha");
  });
});
