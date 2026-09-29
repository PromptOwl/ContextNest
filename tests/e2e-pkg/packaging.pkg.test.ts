/**
 * QA release-gate suite — packaging & install integrity for @promptowl/contextnest-cli.
 *
 * OWNER: QA / Test Automation (distinct from the dev-owned in-repo
 * *.regression.test.ts, which spawns the in-repo dist directly).
 *
 * WHY THIS EXISTS: dev's regression suite runs the in-repo build and therefore
 * cannot see anything that only breaks once the package is *published and
 * installed*. This suite packs the real tarball (`npm pack`), installs it into
 * a clean directory with NO workspace on the path, and drives the installed
 * binary — catching the packaging failure modes the source suite is blind to:
 *
 *   - a `files` allowlist that forgets to ship something dist needs
 *   - the engine / zod / mcp-sdk are devDependencies BUNDLED by tsup (not
 *     runtime deps); if bundling regresses, the installed CLI can't find its
 *     engine even though every in-repo test still passes
 *   - `chalk` is an optionalDependency — the CLI must run when it is absent
 *   - the `bin` field must map both `ctx` and `contextnest`
 *
 * WHEN IT RUNS: gated to release PRs / pre-publish, on the OS × Node matrix.
 * Run locally with `pnpm test:pkg` (builds the CLI first).
 *
 * REQUIRES: network access (the tarball install resolves `commander` from the
 * registry) and a working `npm` on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const cliDir = join(repoRoot, "packages", "cli");
const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8")) as {
  name: string;
  version: string;
};

const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

/**
 * Run npm and return stdout. On Windows, `npm` is a `.cmd` shim, which Node
 * refuses to spawn without `shell: true` (EINVAL since the child_process
 * hardening fix) — and under a shell, args with spaces must be quoted by hand.
 */
function npmExec(args: string[], cwd: string): string {
  const a = isWin ? args.map((x) => (/[\s"]/.test(x) ? `"${x}"` : x)) : args;
  return execFileSync(npm, a, { cwd, encoding: "utf-8", shell: isWin });
}

// Where the CLI ends up once installed from the tarball.
const installedEntry = (installDir: string) =>
  join(installDir, "node_modules", "@promptowl", "contextnest-cli", "dist", "index.js");
const installedPkgDir = (installDir: string) =>
  join(installDir, "node_modules", "@promptowl", "contextnest-cli");

// Scratch dirs, all under the OS temp root, torn down after the suite.
let PACK_DIR: string; // holds the packed .tgz
let tarball: string; // absolute path to the packed tarball
let INSTALL: string; // clean install with optional deps (chalk present)
const scratch: string[] = [];

/** A registry-sandboxed, browserless, ambient-selector-free env — never touch the real ~/.contextnest. */
function sandboxEnv(configDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTEXTNEST_NO_BROWSER: "1",
    CONTEXTNEST_CONFIG_DIR: configDir,
    CONTEXTNEST_VAULT: "",
    CONTEXTNEST_VAULT_PATH: "",
    CONTEXTNEST_AGENT: "",
    CONTEXTNEST_SESSION_ID: "",
  };
}

/** Run the INSTALLED cli entrypoint via node; returns exit status + streams. */
function runInstalled(
  installDir: string,
  cwd: string,
  args: string[],
  configDir: string,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("node", [installedEntry(installDir), ...args], {
    cwd,
    env: sandboxEnv(configDir),
    encoding: "utf-8",
  });
  return {
    status: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Install the packed tarball into a fresh dir. `omitOptional` skips chalk. */
function freshInstall(label: string, omitOptional = false): string {
  const dir = mkdtempSync(join(tmpdir(), `cn-pkg-${label}-`));
  scratch.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `cn-pkg-smoke-${label}`, version: "0.0.0", private: true }),
  );
  const args = ["install", tarball, "--no-audit", "--no-fund", "--no-save"];
  if (omitOptional) args.push("--omit=optional");
  npmExec(args, dir);
  return dir;
}

beforeAll(() => {
  // Guard: the tarball reflects whatever is in dist/. If dist is missing the
  // failure is a stale build, not a packaging bug — say so plainly.
  if (!existsSync(join(cliDir, "dist", "index.js"))) {
    throw new Error(
      "packages/cli/dist/index.js is missing — build first: `pnpm --filter @promptowl/contextnest-cli build` (or run via `pnpm test:pkg`).",
    );
  }

  PACK_DIR = mkdtempSync(join(tmpdir(), "cn-pkg-pack-"));
  scratch.push(PACK_DIR);

  // `npm pack --json` prints an array; [0].filename is the tarball name.
  const out = npmExec(["pack", "--json", "--pack-destination", PACK_DIR], cliDir);
  const packed = JSON.parse(out) as Array<{ filename: string }>;
  tarball = join(PACK_DIR, packed[0].filename);

  INSTALL = freshInstall("main");
}, 180_000);

afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("[pkg] packaging & install integrity", () => {
  it("PKG-01 — npm pack produces a tarball that installs clean into a fresh dir", () => {
    expect(existsSync(tarball)).toBe(true);
    expect(existsSync(installedPkgDir(INSTALL))).toBe(true);
    expect(existsSync(installedEntry(INSTALL))).toBe(true);
  });

  it("PKG-02 — the files allowlist ships dist + README and nothing internal", () => {
    const shipped = readdirSync(installedPkgDir(INSTALL));
    expect(shipped).toContain("dist");
    expect(shipped).toContain("README.md");
    // src / tests / configs must NOT be published.
    expect(shipped).not.toContain("src");
    expect(shipped).not.toContain("tsconfig.json");
    expect(shipped).not.toContain("vitest.config.ts");
  });

  it("PKG-03 — the engine is BUNDLED: the CLI runs with no workspace/devDeps present", () => {
    const modules = join(INSTALL, "node_modules");
    // These are devDependencies of the CLI, expected to be bundled into dist —
    // so they must NOT appear as installed packages...
    expect(existsSync(join(modules, "@promptowl", "contextnest-engine"))).toBe(false);
    expect(existsSync(join(modules, "zod"))).toBe(false);
    expect(existsSync(join(modules, "@modelcontextprotocol"))).toBe(false);
    // ...yet the installed CLI must still run. If this fails, bundling regressed.
    const cfg = mkdtempSync(join(tmpdir(), "cn-pkg-cfg-"));
    scratch.push(cfg);
    const r = runInstalled(INSTALL, INSTALL, ["--version"], cfg);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(cliPkg.version);
  });

  it("PKG-04 — both bin shims (ctx + contextnest) are wired", () => {
    const binDir = join(INSTALL, "node_modules", ".bin");
    const shim = (name: string) => (isWin ? [`${name}.cmd`, `${name}.ps1`] : [name]);
    for (const name of ["ctx", "contextnest"]) {
      const present = shim(name).some((f) => existsSync(join(binDir, f)));
      expect(present, `${name} bin shim missing`).toBe(true);
    }
  });

  it("PKG-05 — runs without chalk (optionalDependency absent)", () => {
    const noChalk = freshInstall("nochalk", /* omitOptional */ true);
    expect(existsSync(join(noChalk, "node_modules", "chalk"))).toBe(false);
    const cfg = mkdtempSync(join(tmpdir(), "cn-pkg-cfg-"));
    scratch.push(cfg);
    const r = runInstalled(noChalk, noChalk, ["--version"], cfg);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(cliPkg.version);
  });

  it("PKG-06 — --version matches the packed package.json", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cn-pkg-cfg-"));
    scratch.push(cfg);
    const r = runInstalled(INSTALL, INSTALL, ["--version"], cfg);
    expect(r.stdout.trim()).toBe(cliPkg.version);
  });

  it("PKG-07 — the installed bin initializes a vault and verifies clean", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cn-pkg-cfg-"));
    const vault = mkdtempSync(join(tmpdir(), "cn-pkg-vault-"));
    scratch.push(cfg, vault);
    const init = runInstalled(INSTALL, vault, ["init", "--name", "pkg-smoke"], cfg);
    expect(init.status, init.stderr).toBe(0);
    const verify = runInstalled(INSTALL, vault, ["verify"], cfg);
    expect(verify.status, verify.stderr).toBe(0);
  });
});

describe("[pkg] breadth journey — each command group once, on the installed bin", () => {
  it("PKG-08 — init → config → add → update → query → search → list → read → history → validate → verify", () => {
    const cfg = mkdtempSync(join(tmpdir(), "cn-pkg-cfg-"));
    const vault = mkdtempSync(join(tmpdir(), "cn-pkg-journey-"));
    scratch.push(cfg, vault);
    const run = (args: string[]) => runInstalled(INSTALL, vault, args, cfg);
    const ok = (args: string[], label: string) => {
      const r = run(args);
      expect(r.status, `${label} failed: ${r.stderr || r.stdout}`).toBe(0);
      return r;
    };

    // Setup
    ok(["init", "--name", "journey"], "init");
    // Review gate is on by default for new vaults — turn it off so the journey
    // publishes deterministically (the gate itself is dev-covered).
    ok(["config", "set", "review", "off"], "config set");
    // Create (auto-publishes with the gate off)
    ok(["add", "nodes/hello", "--title", "Hello World", "--tags", "#demo", "-y"], "add");
    // Edit → cuts a new version
    ok(["update", "nodes/hello", "--body", "Updated body text.", "-y"], "update");

    // Find & retrieve — every surface must RUN (breadth). Content is asserted
    // on the deterministic surfaces only: `resolve` (pure selector, no
    // traversal) and `list`. Graph-mode `query` legitimately returns nothing
    // for a lone unlinked node since #134 (min inbound degree to be a hub), so
    // the journey checks it runs, not that it surfaces the node.
    ok(["query", "#demo", "--json"], "query");
    ok(["search", "Updated", "--json"], "search");
    const resolved = ok(["resolve", "#demo"], "resolve");
    expect(resolved.stdout).toContain("hello");
    const list = ok(["list", "--json"], "list");
    expect(list.stdout).toContain("hello");

    // Read back the content
    const read = ok(["read", "nodes/hello"], "read");
    expect(read.stdout).toContain("Updated body text.");

    // Versions & integrity
    const history = ok(["history", "nodes/hello", "--json"], "history");
    expect(history.stdout).toContain("version");
    ok(["validate"], "validate");
    ok(["verify"], "verify");
  });
});
