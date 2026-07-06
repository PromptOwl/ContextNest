/**
 * Context Nest plugin — shared core helpers.
 *
 * Agent-agnostic. Nothing here imports a Claude-specific API; every module in
 * this directory only reads stdin JSON + environment variables and shells out
 * to the `ctx` CLI. That keeps the same files reusable byte-for-byte by future
 * Codex / Gemini adapters.
 *
 * SINGLE SOURCE OF TRUTH: this file lives at plugins/shared/core/ and is
 * vendored into each agent plugin's core/ directory by scripts/sync-plugins.mjs.
 * Edit it here, then run `pnpm plugins:sync`.
 */

import { execFileSync } from "node:child_process";

/** Default cap on how many registered vaults the cheap tiers fan out across. */
export const MAX_FANOUT_VAULTS = 5;
/** Default cap on how many retrieval hits we inject. */
export const MAX_HITS = 6;

/**
 * Read plugin configuration from the environment.
 *
 * Claude Code exports userConfig values as CLAUDE_PLUGIN_OPTION_<KEY>. Other
 * agents (Codex/Gemini) that lack a userConfig mechanism can feed the same
 * values via the generic CONTEXTNEST_* fallbacks.
 *
 * @param {Record<string, string | undefined>} env
 */
export function getConfig(env = process.env) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = env[k];
      if (v !== undefined && v !== "") return v;
    }
    return undefined;
  };

  const rawAuto = pick(
    "CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE",
    "CONTEXTNEST_AUTO_CAPTURE",
  );

  return {
    retrievalMode: (
      pick("CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE", "CONTEXTNEST_RETRIEVAL_MODE") ||
      "search"
    ).toLowerCase(),
    // Default ON. Only an explicit false/0/no disables it.
    autoCapture: rawAuto === undefined ? true : !/^(false|0|no|off)$/i.test(rawAuto),
    // Pinned vault alias. Deliberately NOT named CONTEXTNEST_VAULT so it never
    // collides with the env var the ctx CLI itself consumes for resolution.
    vault: pick("CLAUDE_PLUGIN_OPTION_VAULT", "CONTEXTNEST_VAULT_ALIAS") || "",
    ctxCommand:
      pick("CLAUDE_PLUGIN_OPTION_CTX_COMMAND", "CONTEXTNEST_CTX_COMMAND") || "ctx",
  };
}

/**
 * Build the default synchronous `ctx` runner. Tries the configured command,
 * and on ENOENT (no global install) transparently falls back to npx.
 *
 * The returned function has the injectable shape the run() handlers expect:
 *   exec(args: string[]) => { status, stdout, stderr }
 *
 * @param {ReturnType<typeof getConfig>} config
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export function makeExec(config, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;

  const attempt = (cmd, args) => {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      return {
        status: typeof err.status === "number" ? err.status : 1,
        stdout: err.stdout ? String(err.stdout) : "",
        stderr: err.stderr ? String(err.stderr) : "",
        code: err.code,
      };
    }
  };

  return (args) => {
    const res = attempt(config.ctxCommand, args);
    if (res.code === "ENOENT") {
      return attempt("npx", ["-y", "@promptowl/contextnest-cli", ...args]);
    }
    return res;
  };
}

/** Parse JSON without throwing. Returns `fallback` on any failure. */
export function safeJson(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Run a ctx subcommand expecting JSON on stdout. Returns the parsed value, or
 * `fallback` when ctx failed or emitted non-JSON.
 *
 * @param {(args: string[]) => {status:number, stdout:string}} exec
 * @param {string[]} args
 */
export function ctxJson(exec, args, fallback = null) {
  const res = exec(args);
  if (!res || res.status !== 0) return fallback;
  return safeJson(res.stdout, fallback);
}

/**
 * Append `--vault <alias>` when a vault is explicitly given. ctx accepts the
 * global flag before or after the subcommand, so appending is safe.
 */
export function withVault(args, alias) {
  return alias ? [...args, "--vault", alias] : args;
}

/**
 * List registered vaults from the central registry.
 * @returns {{alias:string, path:string, description?:string, isDefault?:boolean, exists?:boolean}[]}
 */
export function listVaults(exec) {
  const vaults = ctxJson(exec, ["vault", "list", "--json"], []);
  return Array.isArray(vaults) ? vaults : [];
}

/**
 * Decide which vault aliases the cheap (non-agent) tiers should search.
 *
 *  - Pinned alias set        → just that alias.
 *  - Unpinned + registry     → fan out across registered vaults (capped).
 *  - Unpinned + empty registry → a single null target, i.e. let ctx resolve the
 *                                 local/default vault with no --vault flag.
 *
 * @param {ReturnType<typeof getConfig>} config
 * @param {(args:string[]) => any} exec
 * @returns {(string|null)[]} list of alias targets (null = ctx default resolution)
 */
export function vaultTargets(config, exec) {
  if (config.vault) return [config.vault];
  const vaults = listVaults(exec).filter((v) => v.exists !== false);
  if (vaults.length === 0) return [null];
  return vaults.slice(0, MAX_FANOUT_VAULTS).map((v) => v.alias);
}

/** Collapse internal whitespace and trim, for compact single-line context. */
export function squish(text, max = 200) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/**
 * Read all of stdin as a string (used by the IO shells). Resolves to "" if
 * stdin is closed/empty so a hook firing with no payload never hangs.
 */
export function readStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    if (stream.isTTY) return resolve("");
    stream.setEncoding("utf-8");
    stream.on("data", (c) => (data += c));
    stream.on("end", done);
    stream.on("error", done);
    stream.on("close", done);
  });
}

/**
 * The standard IO shell for a hook handler: read+parse stdin, invoke run() with
 * a default exec, print any returned object as JSON, and ALWAYS exit 0. Hooks
 * must never break a session, so every error path is swallowed (to stderr only).
 *
 * @param {(ctx:{input:any, env:NodeJS.ProcessEnv, exec:Function}) => any|Promise<any>} run
 */
export async function runAsHook(run) {
  try {
    const raw = await readStdin();
    const input = raw ? safeJson(raw, {}) : {};
    const env = process.env;
    const config = getConfig(env);
    const exec = makeExec(config, { cwd: input.cwd || process.cwd(), env });
    const out = await run({ input, env, exec });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stderr.write(`[contextnest] hook error: ${err?.message || err}\n`);
  }
  process.exit(0);
}

/** True when this module file is the process entry point (ESM main check). */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === new URL(`file://${entry}`).href;
  } catch {
    return false;
  }
}
