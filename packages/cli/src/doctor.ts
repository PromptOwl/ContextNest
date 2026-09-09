/**
 * `ctx doctor` — one screen of the facts that go stale silently.
 *
 * The CLI, the engine bundled into it, the Claude Code plugin and the npm
 * registry all carry their own version, and nothing compared them: an install
 * sat two minors behind npm for months, and a registry whose default pointed at
 * a deleted temp directory only surfaced as "wrong vault" bugs. This module
 * gathers the report; the command in index.ts renders it.
 *
 * Everything here is best-effort and never throws — a diagnostic that crashes
 * is worse than one that says "unknown".
 */

import fs from "node:fs";
import pathMod from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  ENGINE_VERSION,
  findLocalVault,
  getRegistryPath,
  listVaults,
  readRegistry,
} from "@promptowl/contextnest-engine";

export const CLI_PACKAGE_NAME = "@promptowl/contextnest-cli";
/** How long `npm view` gets before the doctor gives up and reports `null`. */
export const NPM_VIEW_TIMEOUT_MS = 3000;

export interface DoctorReport {
  cli: { version: string; path: string };
  engine: { version: string };
  /** Latest published CLI version, or null when npm was unreachable / skipped. */
  latest: string | null;
  /** True when `latest` is newer than the installed CLI; null when unknown. */
  update_available: boolean | null;
  registry: {
    path: string;
    vaults: number;
    remotes: number;
    /** Local aliases whose path is no longer a vault (what `vault list` marks `[missing]`). */
    missing: number;
    missing_aliases: string[];
    default: string | null;
    /** The default alias names a missing local vault, or no entry at all. */
    default_missing: boolean;
    /** Set when the registry file could not be read/parsed. */
    error?: string;
  };
  cwd: {
    path: string;
    in_vault: boolean;
    vault_path: string | null;
    /** The registered alias for that vault, when it has one. */
    alias: string | null;
  };
  plugin: {
    /** Installed Claude Code plugin version, or null when not installed / not readable. */
    version: string | null;
    /** The manifest the version was read from, or null when none was readable. */
    path: string | null;
  };
}

/** Skip the network entirely. Any non-empty value counts. */
export function isDoctorOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CONTEXTNEST_DOCTOR_OFFLINE);
}

/**
 * `npm view <pkg> version`, bounded by `timeoutMs`. Resolves null on any
 * failure: no npm on PATH, offline, a hung registry, garbage output.
 *
 * Uses spawn rather than execFile so the timer alone decides when to give up:
 * execFile waits for stdio to close, and a grandchild (npm spawns helpers)
 * holding the pipe open would stretch a "3s timeout" to however long it lived.
 *
 * `pkgName` MUST be a trusted constant. On Windows the spawn runs through a
 * shell (npm is a .cmd shim), so an attacker-controlled name would be a command
 * injection. The only call site passes CLI_PACKAGE_NAME; keep it that way.
 */
export function fetchLatestVersion(
  pkgName: string,
  timeoutMs = NPM_VIEW_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (isDoctorOffline(env)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // `npm` is a .cmd shim on Windows, which execFile/spawn will only run
      // through a shell (Node refuses .cmd without one since the CVE fix).
      child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["view", pkgName, "version"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: process.platform === "win32",
        windowsHide: true,
        env,
      });
    } catch {
      done(null);
      return;
    }
    let out = "";
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    const timer = setTimeout(() => {
      done(null);
      // On Windows the child is the cmd.exe shell running the npm.cmd shim;
      // kill() only ends that shell and leaks the node.exe grandchild doing
      // the actual work. taskkill /T takes the whole process tree down.
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          })
            .on("error", () => {})
            .unref();
        } catch {
          /* taskkill missing or refused — fall through to kill() */
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // Drop our end of the pipe and stop waiting on the process, so a helper
      // that outlives the kill cannot keep this CLI alive.
      child.stdout?.destroy();
      child.unref();
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(null);
        return;
      }
      // `npm view` prints one version per matching package; take the last line
      // and require it to look like a version, so a warning banner is not
      // mistaken for one.
      const last = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
      done(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(last) ? last : null);
    });
  });
}

/**
 * Numeric x.y.z comparison, with semver's rule that a prerelease sorts before
 * the release it leads to — otherwise someone on `2.5.0-beta.1` is told they
 * are up to date with a published `2.5.0`. null when unparsable.
 *
 * ponytail: two prereleases of the same x.y.z compare equal (no identifier
 * ordering); reach for a real semver parser if that ever needs to be exact.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1;
  return 0;
}

/**
 * Where Claude Code keeps its plugin manifest. `CLAUDE_CONFIG_DIR` is the
 * official override for the whole config directory; `homedir()` follows HOME
 * (USERPROFILE on Windows), so tests can sandbox either way.
 */
export function claudePluginManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || pathMod.join(homedir(), ".claude");
  return pathMod.join(base, "plugins", "installed_plugins.json");
}

/**
 * The installed ContextNest plugin version from Claude Code's manifest. The
 * manifest maps `<plugin>@<marketplace>` to either an install record or a list
 * of them (one per scope); the first record with a version wins. Any read or
 * parse failure reads as "not installed".
 */
export function readClaudePluginVersion(manifestPath: string): DoctorReport["plugin"] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return { version: null, path: null };
  }
  const plugins =
    raw && typeof raw === "object" && "plugins" in raw
      ? (raw as { plugins?: unknown }).plugins
      : raw;
  if (!plugins || typeof plugins !== "object") return { version: null, path: manifestPath };
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!key.startsWith("contextnest@")) continue;
    const records = Array.isArray(value) ? value : [value];
    for (const rec of records) {
      const version = (rec as { version?: unknown } | null)?.version;
      if (typeof version === "string" && version) return { version, path: manifestPath };
    }
  }
  return { version: null, path: manifestPath };
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return pathMod.resolve(p);
  }
}

/** Registry health, from the same `listVaults()` view `ctx vault list` renders. */
export function inspectRegistry(): DoctorReport["registry"] {
  const path = getRegistryPath();
  try {
    const reg = readRegistry();
    const entries = listVaults();
    const locals = entries.filter((v) => v.kind === "local");
    const missing = locals.filter((v) => !v.exists).map((v) => v.alias);
    const def = reg.default ?? null;
    const defaultEntry = def ? entries.find((v) => v.alias === def) : undefined;
    const defaultMissing =
      def !== null && (!defaultEntry || (defaultEntry.kind === "local" && !defaultEntry.exists));
    return {
      path,
      vaults: locals.length,
      remotes: entries.length - locals.length,
      missing: missing.length,
      missing_aliases: missing,
      default: def,
      default_missing: defaultMissing,
    };
  } catch (err) {
    return {
      path,
      vaults: 0,
      remotes: 0,
      missing: 0,
      missing_aliases: [],
      default: null,
      default_missing: false,
      error: (err as Error).message,
    };
  }
}

/** Is `cwd` inside a vault, and is that vault registered under an alias? */
export function inspectCwd(cwd: string): DoctorReport["cwd"] {
  const vaultPath = findLocalVault(cwd);
  if (!vaultPath) return { path: cwd, in_vault: false, vault_path: null, alias: null };
  let alias: string | null = null;
  try {
    const target = realpathOr(vaultPath);
    for (const [name, entry] of Object.entries(readRegistry().vaults)) {
      if (realpathOr(entry.path) === target) {
        alias = name;
        break;
      }
    }
  } catch {
    // unreadable registry: the cwd answer is still valid without an alias
  }
  return { path: cwd, in_vault: true, vault_path: vaultPath, alias };
}

export interface BuildDoctorReportOptions {
  cliVersion: string;
  cliPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function buildDoctorReport(opts: BuildDoctorReportOptions): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const [latest, registry, cwd] = await Promise.all([
    fetchLatestVersion(CLI_PACKAGE_NAME, opts.timeoutMs, env),
    Promise.resolve().then(inspectRegistry),
    Promise.resolve().then(() => inspectCwd(opts.cwd ?? process.cwd())),
  ]);
  const cmp = latest ? compareVersions(opts.cliVersion, latest) : null;
  return {
    cli: { version: opts.cliVersion, path: opts.cliPath },
    engine: { version: ENGINE_VERSION },
    latest,
    update_available: cmp === null ? null : cmp < 0,
    registry,
    cwd,
    plugin: readClaudePluginVersion(claudePluginManifestPath(env)),
  };
}
