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
 * The shared install-and-drive scaffolding lives in ./journey-harness, so the
 * breadth journey (PKG-08) and the user-journey suites reuse it rather than
 * each rebuilding pack/install/spawn/assert.
 *
 * WHEN IT RUNS: gated to release PRs / pre-publish, on the OS × Node matrix.
 * Run locally with `pnpm test:pkg` (builds the CLI first).
 *
 * REQUIRES: network access (the tarball install resolves `commander` from the
 * registry) and a working `npm` on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliPkg,
  isWin,
  installedEntry,
  installedPkgDir,
  packCli,
  freshInstall,
  runInstalled,
  runJourney,
  type Journey,
} from "./journey-harness.js";

// Scratch dirs, all under the OS temp root, torn down after the suite.
let tarball: string; // absolute path to the packed tarball
let INSTALL: string; // clean install with optional deps (chalk present)
const scratch: string[] = [];

beforeAll(() => {
  tarball = packCli(scratch);
  INSTALL = freshInstall(tarball, scratch, "main");
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
    const noChalk = freshInstall(tarball, scratch, "nochalk", /* omitOptional */ true);
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
    // Ported onto the shared harness: the breadth smoke is now expressed as a
    // declarative journey, the same shape every user-journey suite uses.
    //
    // Content is asserted on the deterministic surfaces only — `resolve` (pure
    // selector, no traversal), `list`, and `read`. Graph-mode `query`
    // legitimately returns nothing for a lone unlinked node since #134 (minimum
    // inbound degree to be a hub), so the journey checks it RUNS, not that it
    // surfaces the node.
    const journey: Journey = {
      id: "PKG-08",
      title: "breadth smoke — each command group once",
      cases: [
        {
          id: "PKG-08",
          title: "init → config → add → update → query → search → list → read → history → validate → verify",
          actions: [
            { args: ["init", "--name", "journey"] },
            // Review gate is on by default — turn it off so add publishes
            // deterministically (the gate itself is dev-covered).
            { args: ["config", "set", "review", "off"] },
            { args: ["add", "nodes/hello", "--title", "Hello World", "--tags", "#demo", "-y"] },
            { args: ["update", "nodes/hello", "--body", "Updated body text.", "-y"] },
            { args: ["query", "#demo", "--json"] },
            { args: ["search", "Updated", "--json"] },
            { args: ["resolve", "#demo"], stdout: ["hello"] },
            { args: ["list", "--json"], stdout: ["hello"] },
            { args: ["read", "nodes/hello"], stdout: ["Updated body text."] },
            { args: ["history", "nodes/hello", "--json"], stdout: ["version"] },
            { args: ["validate"] },
            { args: ["verify"] },
          ],
        },
      ],
    };
    runJourney({ installDir: INSTALL, scratch }, journey);
  });
});
