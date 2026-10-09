/**
 * QA release-gate harness — shared scaffolding for the install-and-drive
 * journey tests under tests/e2e-pkg/.
 *
 * WHY THIS EXISTS: without it, every journey re-implements the same plumbing —
 * pack the real tarball, install it into a clean dir with NO workspace on PATH,
 * spawn the INSTALLED bin in an isolated vault, read its output, assert, clean
 * up — and re-solves the same cross-platform quirks (Windows `npm` is a `.cmd`
 * shim Node won't spawn without a shell; output arrives CRLF on Windows, LF
 * elsewhere). This module solves all of that once, so a new journey is a
 * declarative list of steps rather than new code.
 *
 * It is NOT a second regression suite. Journeys drive each capability through a
 * realistic user story (breadth — touch a surface once). Per-command depth
 * (every flag, every negative) stays in the dev-owned *.regression.test.ts.
 */
import { expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");
export const cliDir = join(repoRoot, "packages", "cli");
export const cliPkg = JSON.parse(
  readFileSync(join(cliDir, "package.json"), "utf-8"),
) as { name: string; version: string };

export const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

/**
 * Run npm and return stdout. On Windows, `npm` is a `.cmd` shim, which Node
 * refuses to spawn without `shell: true` (EINVAL since the child_process
 * hardening fix) — and under a shell, args with spaces must be quoted by hand.
 */
export function npmExec(args: string[], cwd: string): string {
  const a = isWin ? args.map((x) => (/[\s"]/.test(x) ? `"${x}"` : x)) : args;
  return execFileSync(npm, a, { cwd, encoding: "utf-8", shell: isWin });
}

/** Where the CLI ends up once installed from the tarball. */
export const installedEntry = (installDir: string) =>
  join(installDir, "node_modules", "@promptowl", "contextnest-cli", "dist", "index.js");
export const installedPkgDir = (installDir: string) =>
  join(installDir, "node_modules", "@promptowl", "contextnest-cli");

/** A registry-sandboxed, browserless, ambient-selector-free env — never touch the real ~/.contextnest. */
export function sandboxEnv(configDir: string): NodeJS.ProcessEnv {
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

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the INSTALLED cli entrypoint via node; returns exit status + streams. */
export function runInstalled(
  installDir: string,
  cwd: string,
  args: string[],
  configDir: string,
): RunResult {
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

/**
 * Pack the CLI tarball once. The tarball reflects whatever is in dist/, so a
 * missing dist is a stale build (not a packaging bug) — say so plainly.
 * Caller owns `scratch` cleanup.
 */
export function packCli(scratch: string[]): string {
  if (!existsSync(join(cliDir, "dist", "index.js"))) {
    throw new Error(
      "packages/cli/dist/index.js is missing — build first: `pnpm --filter @promptowl/contextnest-cli build` (or run via `pnpm test:pkg`).",
    );
  }
  const packDir = mkdtempSync(join(tmpdir(), "cn-pkg-pack-"));
  scratch.push(packDir);
  // `npm pack --json` prints an array; [0].filename is the tarball name.
  const out = npmExec(["pack", "--json", "--pack-destination", packDir], cliDir);
  const packed = JSON.parse(out) as Array<{ filename: string }>;
  return join(packDir, packed[0].filename);
}

/** Install the packed tarball into a fresh dir. `omitOptional` skips chalk. */
export function freshInstall(
  tarball: string,
  scratch: string[],
  label: string,
  omitOptional = false,
): string {
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

/** A fresh isolated vault + config dir for one journey. Caller owns cleanup via `scratch`. */
export function makeSandbox(
  scratch: string[],
  label: string,
): { vault: string; cfg: string } {
  const vault = mkdtempSync(join(tmpdir(), `cn-journey-${label}-`));
  const cfg = mkdtempSync(join(tmpdir(), `cn-journey-cfg-${label}-`));
  scratch.push(vault, cfg);
  return { vault, cfg };
}

/** Normalize CRLF so output matchers are platform-agnostic. */
const norm = (s: string) => s.replace(/\r\n/g, "\n");

/** Parse JSON from stdout, tolerating a leading human line before the payload. */
export function parseJson(stdout: string): unknown {
  const s = norm(stdout);
  const i = s.search(/[[{]/);
  if (i < 0) throw new Error(`no JSON found in output:\n${stdout}`);
  return JSON.parse(s.slice(i));
}

type Matcher = string | RegExp;
const matches = (haystack: string, m: Matcher) =>
  typeof m === "string" ? norm(haystack).includes(m) : m.test(norm(haystack));

/**
 * One command run plus the checks on its result. A case (a numbered line in the
 * ticket) is made of one or more actions — e.g. "capture three nodes" is three
 * `add` actions; "drafts become published" is list → publish → list.
 */
export interface Action {
  /**
   * Mutate the vault on disk BEFORE this action's command runs — e.g. corrupt a
   * version-history file to prove `verify` catches tampering, or delete a node
   * to set up a restore. `vaultDir` is the journey's isolated vault root. This
   * is the one escape hatch from the pure drive-the-bin model, for the handful
   * of journeys (integrity, disaster-recovery, forget) whose story requires the
   * vault to change out from under the CLI between commands.
   */
  mutate?: (vaultDir: string) => void;
  /** The ctx args to run (e.g. ["add", "nodes/x", "-y"]). */
  args: string[];
  /** Expected exit status (default 0). */
  status?: number;
  /** Every matcher must appear in stdout. */
  stdout?: Matcher[];
  /** No matcher may appear in stdout. */
  stdoutNot?: Matcher[];
  /** Every matcher must appear in stderr. */
  stderr?: Matcher[];
  /** Assert over stdout parsed as JSON. */
  json?: (data: unknown) => void;
  /** File assertions; `path` is relative to the vault root. */
  files?: Array<{ path: string; exists?: boolean; contains?: string }>;
}

/**
 * A test case — one numbered line in the ticket. `id` and `title` are the
 * ticket's verbatim id and wording, so a red run names the exact ticket case.
 */
export interface Case {
  /** Ticket case id, e.g. "J1-02". */
  id: string;
  /** Ticket case title, verbatim. */
  title: string;
  /** One or more commands that make up this case. */
  actions: Action[];
}

export interface Journey {
  /** Short id, e.g. "J1". */
  id: string;
  /** The plain-language user story this journey proves. */
  title: string;
  cases: Case[];
}

export interface JourneyContext {
  installDir: string;
  scratch: string[];
}

/**
 * Run one journey end-to-end against the INSTALLED bin in its own fresh,
 * isolated vault. Cases (and the actions within them) share the vault and run
 * in order — a journey is a single accumulating story. Every failure names the
 * ticket case id + title and the exact command, so a red run points straight at
 * the case it maps to.
 */
export function runJourney(ctx: JourneyContext, journey: Journey): void {
  const { vault, cfg } = makeSandbox(ctx.scratch, journey.id.toLowerCase());
  for (const c of journey.cases) {
    for (const a of c.actions) {
      if (a.mutate) a.mutate(vault);
      const r = runInstalled(ctx.installDir, vault, a.args, cfg);
      const at = `${c.id} — ${c.title} [ctx ${a.args.join(" ")}]`;
      expect(r.status, `${at} — exit ${r.status}: ${r.stderr || r.stdout}`).toBe(
        a.status ?? 0,
      );
      for (const m of a.stdout ?? [])
        expect(matches(r.stdout, m), `${at} — stdout missing ${m}:\n${r.stdout}`).toBe(true);
      for (const m of a.stdoutNot ?? [])
        expect(matches(r.stdout, m), `${at} — stdout should not contain ${m}:\n${r.stdout}`).toBe(false);
      for (const m of a.stderr ?? [])
        expect(matches(r.stderr, m), `${at} — stderr missing ${m}:\n${r.stderr}`).toBe(true);
      if (a.json) a.json(parseJson(r.stdout));
      for (const f of a.files ?? []) {
        const p = join(vault, f.path);
        if (f.exists !== undefined)
          expect(existsSync(p), `${at} — expected ${f.path} exists=${f.exists}`).toBe(f.exists);
        if (f.contains !== undefined)
          expect(
            norm(readFileSync(p, "utf-8")).includes(f.contains),
            `${at} — ${f.path} missing ${f.contains}`,
          ).toBe(true);
      }
    }
  }
}
