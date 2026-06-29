import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

// Sandbox the central vault registry so `ctx init` (which auto-registers an
// alias non-interactively) never writes to the developer's / CI runner's real
// ~/.contextnest/config.yaml. Cleared up after the whole suite.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-init-cfg-"));
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

function runInit(cwd: string, extraEnv: Record<string, string> = {}): void {
  execFileSync(
    "node",
    [distPath, "init", "--name", "child-vault", "--layout", "structured"],
    {
      cwd,
      env: {
        ...process.env,
        CONTEXTNEST_NO_BROWSER: "1",
        CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
        CONTEXTNEST_VAULT: "",
        CONTEXTNEST_VAULT_PATH: "",
        ...extraEnv,
      },
      stdio: "ignore",
    },
  );
}

describe("ctx init — targets the current directory, not an ancestor vault", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-init-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the vault in cwd even when an ancestor directory is already a vault", () => {
    // A stray ancestor vault that the old walk-up logic would resolve to.
    const parent = join(tmp, "parent");
    mkdirSync(join(parent, ".context"), { recursive: true });
    writeFileSync(
      join(parent, ".context", "config.yaml"),
      "version: 1\nname: stray-ancestor\n",
    );

    // Run init from a child directory below that ancestor.
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    runInit(child);

    // The new vault lives in the child (cwd)...
    expect(existsSync(join(child, ".context", "config.yaml"))).toBe(true);
    expect(readFileSync(join(child, ".context", "config.yaml"), "utf8")).toContain(
      "child-vault",
    );
    // ...and the ancestor is left untouched.
    expect(
      readFileSync(join(parent, ".context", "config.yaml"), "utf8"),
    ).toContain("stray-ancestor");
  });

  it("honors the CONTEXTNEST_VAULT_PATH override", () => {
    const target = join(tmp, "explicit");
    mkdirSync(target, { recursive: true });

    // Run from an unrelated cwd but point the env at the explicit target.
    runInit(tmp, { CONTEXTNEST_VAULT_PATH: target });

    expect(existsSync(join(target, ".context", "config.yaml"))).toBe(true);
    expect(existsSync(join(tmp, ".context", "config.yaml"))).toBe(false);
  });
});
