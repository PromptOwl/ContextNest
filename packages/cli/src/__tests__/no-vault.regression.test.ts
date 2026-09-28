/**
 * [regression] NO_VAULT guard — CU-wdqcq01c5y.
 *
 * `ctx` used to fall through to the bare cwd whenever nothing else resolved,
 * then auto-index it: `ctx query "#x"` in a plain folder printed "No
 * context.yaml found. Auto-indexing vault..." and wrote a `context.yaml`
 * there, and `ctx list` reported every `.md` under the folder as a draft
 * document. Read commands now refuse a cwd fallback that is not a vault, and
 * write nothing. The other resolution steps (local walk-up, registry default)
 * and `ctx init` are unaffected.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

// Sandbox the central vault registry (see cli.regression.test.ts). A fresh
// registry per test so "empty registry" and "registry with a default" cases
// cannot bleed into each other.
let configDir: string;
let env: NodeJS.ProcessEnv;

function makeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTEXTNEST_NO_BROWSER: "1",
    CONTEXTNEST_CONFIG_DIR: configDir,
    CONTEXTNEST_VAULT: "",
    CONTEXTNEST_VAULT_PATH: "",
  } as NodeJS.ProcessEnv;
}

function runCtx(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], { cwd, env, encoding: "utf-8" });
}

function runCtxResult(
  cwd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("node", [distPath, ...args], { cwd, env, encoding: "utf-8" });
  return {
    status: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function initVault(cwd: string, extra: string[] = []): void {
  execFileSync(
    "node",
    [distPath, "init", "--name", "no-vault-guard", "--layout", "structured", ...extra],
    { cwd, env, stdio: "ignore" },
  );
}

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  configDir = tmp("cn-novault-cfg-");
  env = makeEnv();
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("[regression] NO_VAULT — read commands refuse a non-vault cwd", () => {
  let plain: string;

  beforeEach(() => {
    // A plain folder that merely happens to contain a markdown file — the
    // exact shape of "a folder of repos" that used to get harvested.
    plain = tmp("cn-novault-plain-");
    writeFileSync(join(plain, "readme.md"), "# Not a vault\n");
  });

  for (const args of [["query", "#x"], ["list"], ["search", "x"]]) {
    it(`ctx ${args.join(" ")} exits 1 with NO_VAULT and writes nothing`, () => {
      const res = runCtxResult(plain, args);

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("NO_VAULT");
      expect(res.stderr).toContain("is not a Context Nest vault");
      expect(res.stderr).toContain('Run "ctx init" here');
      // Empty registry → no "(registered: …)" list, suggest listing instead.
      expect(res.stderr).not.toContain("registered:");
      expect(res.stderr).toContain("ctx vault list");
      // The whole point: the folder is untouched.
      expect(readdirSync(plain).sort()).toEqual(["readme.md"]);
      expect(existsSync(join(plain, "context.yaml"))).toBe(false);
      expect(existsSync(join(plain, ".context"))).toBe(false);
    });
  }

  it("names the registered aliases when the registry is not empty", () => {
    // The first registered vault is auto-promoted to default, and a default
    // IS a legitimate fallback (see the resolution-order test below). To get
    // "registered, but no default" register two and remove the default one —
    // removeVault deliberately does not promote a replacement.
    initVault(tmp("cn-novault-vault-a-"), ["--vault", "alpha"]);
    initVault(tmp("cn-novault-vault-b-"), ["--vault", "beta"]);
    runCtx(plain, ["vault", "remove", "alpha", "--yes"]);
    // A registered non-default vault must not be silently substituted for cwd.
    const res = runCtxResult(plain, ["list"]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("NO_VAULT");
    expect(res.stderr).toContain("--vault <alias>");
    expect(res.stderr).toContain("registered: beta");
    expect(res.stderr).not.toContain("ctx vault list");
    expect(readdirSync(plain).sort()).toEqual(["readme.md"]);
  });

  it("a dir containing only a stray context.yaml is still refused", () => {
    // Exactly the residue the old bug left behind. A bare context.yaml is not
    // a vault (no .context/config.yaml) and must not re-admit the folder.
    const polluted = tmp("cn-novault-polluted-");
    writeFileSync(join(polluted, "context.yaml"), "version: 1\ndocuments: []\n");

    const res = runCtxResult(polluted, ["list"]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("NO_VAULT");
    expect(readdirSync(polluted).sort()).toEqual(["context.yaml"]);
  });

  it("ctx vault which marks the refused cwd instead of reporting it as the vault", () => {
    // which is the diagnostic users run right after the NO_VAULT error; it is
    // exempt from the guard (it must still say what resolved) but must not
    // present a directory every other command rejects as a usable vault.
    const res = runCtxResult(plain, ["vault", "which", "--json"]);

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { source: string; refused?: boolean };
    expect(out.source).toBe("cwd");
    expect(out.refused).toBe(true);
    expect(runCtxResult(plain, ["vault", "which"]).stdout).toContain("NO_VAULT");
    expect(readdirSync(plain).sort()).toEqual(["readme.md"]);
  });

  it("ctx add in a non-vault cwd also refuses and writes nothing", () => {
    const res = runCtxResult(plain, ["add", "nodes/stray", "--title", "Stray"]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("NO_VAULT");
    expect(readdirSync(plain).sort()).toEqual(["readme.md"]);
  });
});

describe("[regression] NO_VAULT — resolution order and init are unaffected", () => {
  it("a real vault whose context.yaml was deleted still auto-indexes and answers", () => {
    const vault = tmp("cn-novault-real-");
    initVault(vault);
    runCtx(vault, ["add", "nodes/tagged", "--tags", "#tag"]);
    runCtx(vault, ["publish", "nodes/tagged", "--yes"]);
    unlinkSync(join(vault, "context.yaml"));
    expect(existsSync(join(vault, "context.yaml"))).toBe(false);

    const res = runCtxResult(vault, ["query", "#tag", "--json"]);

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Auto-index");
    expect(res.stderr).not.toContain("NO_VAULT");
    expect(res.stdout).toContain("nodes/tagged");
    expect(existsSync(join(vault, "context.yaml"))).toBe(true);
  });

  it("a registry default vault is used when cwd is not a vault", () => {
    const vault = tmp("cn-novault-default-");
    initVault(vault, ["--vault", "home", "--set-default"]);
    runCtx(vault, ["add", "nodes/from-default", "--title", "From Default"]);

    const elsewhere = tmp("cn-novault-elsewhere-");
    writeFileSync(join(elsewhere, "notes.md"), "# stray\n");

    const res = runCtxResult(elsewhere, ["list"]);

    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("NO_VAULT");
    expect(res.stdout).toContain("nodes/from-default");
    expect(res.stdout).not.toContain("notes");
    expect(readdirSync(elsewhere).sort()).toEqual(["notes.md"]);
  });

  it("ctx init in an empty dir still creates the vault", () => {
    const fresh = tmp("cn-novault-init-");

    const res = runCtxResult(fresh, [
      "init", "--name", "fresh", "--layout", "structured", "--vault", "fresh",
    ]);

    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("NO_VAULT");
    expect(existsSync(join(fresh, ".context", "config.yaml"))).toBe(true);
    // And the vault it just made is usable from inside.
    expect(runCtxResult(fresh, ["list"]).status).toBe(0);
  });

  it("ctx vault list works from a non-vault cwd", () => {
    const plain = tmp("cn-novault-vaultlist-");
    const res = runCtxResult(plain, ["vault", "list"]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("NO_VAULT");
  });
});
