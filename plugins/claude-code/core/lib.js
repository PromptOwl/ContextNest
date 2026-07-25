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
import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/** Default cap on how many registered vaults the cheap tiers fan out across. */
export const MAX_FANOUT_VAULTS = 5;
/** Default cap on how many retrieval hits we inject. */
export const MAX_HITS = 6;

/** Project-level settings override, relative to the project root. */
export const PROJECT_SETTINGS_FILE = join(".claude", "contextnest.local.json");
/** User-level settings override, relative to the home directory. */
export const USER_SETTINGS_FILE = join(".contextnest", "plugin-settings.json");

/**
 * The only accepted retrieval_mode values. Anything else (a typo, a stale
 * value, `SEARCH` in the wrong case) is treated as if the key were absent, so
 * it can never silently degrade to the wrong tier. Shared so the command and
 * tests validate against the same source of truth.
 */
export const VALID_RETRIEVAL_MODES = ["off", "search", "query", "agent"];

/** Recognized truthy / falsy spellings for the boolean auto_capture setting. */
export const TRUTHY_VALUES = ["true", "1", "yes", "on"];
export const FALSY_VALUES = ["false", "0", "no", "off"];

/**
 * Valid shape for a pinned vault alias — mirrors the engine's ALIAS_PATTERN
 * (packages/engine/src/registry.ts), the single source of truth for what ctx
 * accepts. Plugins can't import the engine (they run as standalone vendored
 * JS), so the rule is duplicated here. An empty string is handled separately:
 * it is the deliberate "unpin" value, not a malformed alias. Note this only
 * validates *shape*; whether the alias is actually registered is checked by
 * the /contextnest:config command, which can consult the registry.
 */
export const ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Read a settings override file. Missing or malformed files are silently
 * ignored (hooks must never break a session), as is anything that isn't a
 * plain JSON object.
 */
function readSettingsFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read plugin configuration.
 *
 * Claude Code collects userConfig answers once at enable time and exports
 * them as CLAUDE_PLUGIN_OPTION_<KEY> — they cannot be changed afterwards from
 * within a session. Settings override files exist so users CAN change them
 * later (via /contextnest:config or by editing the file); a key present in a
 * file therefore beats the frozen env value. Precedence, highest first:
 *
 *   1. <project>/.claude/contextnest.local.json
 *   2. ~/.contextnest/plugin-settings.json
 *   3. CLAUDE_PLUGIN_OPTION_* env (enable-time answers)
 *   4. CONTEXTNEST_* env (generic fallbacks for Codex/Gemini adapters)
 *   5. defaults
 *
 * File keys mirror the manifest: retrieval_mode, auto_capture, vault,
 * ctx_command. An explicit "" in a file is honoured (e.g. vault:"" unpins).
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ cwd?: string, homedir?: string }} [opts] injection points for tests
 */
export function getConfig(env = process.env, opts = {}) {
  const cwd = opts.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const home = opts.homedir || osHomedir();
  const fileLayers = [
    readSettingsFile(join(cwd, PROJECT_SETTINGS_FILE)),
    readSettingsFile(join(home, USER_SETTINGS_FILE)),
  ];

  // Resolve one setting across the layers. `envKeys` is scanned after the
  // files. `opts.normalize` transforms a raw value before it is validated and
  // returned; `opts.accept` rejects invalid values — a rejected value is
  // skipped as if that layer never set the key, so resolution falls through to
  // the next layer (and ultimately the default). File layers honour an empty
  // string (e.g. vault:"" unpins); env layers treat "" as absent, as before.
  const pick = (fileKey, envKeys = [], opts = {}) => {
    const finalize = (raw) => {
      const v = opts.normalize ? opts.normalize(String(raw)) : String(raw);
      return opts.accept && !opts.accept(v) ? undefined : v;
    };
    for (const layer of fileLayers) {
      const raw = layer[fileKey];
      if (raw !== undefined && raw !== null) {
        const v = finalize(raw);
        if (v !== undefined) return v;
      }
    }
    for (const k of envKeys) {
      const raw = env[k];
      if (raw !== undefined && raw !== "") {
        const v = finalize(raw);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  };

  // Accept only recognized boolean spellings; a garbage value ("banana", "2")
  // is skipped per layer so it can neither be mistaken for a boolean nor mask
  // a valid lower-precedence value. JSON booleans arrive as "true"/"false".
  const rawAuto = pick(
    "auto_capture",
    ["CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE", "CONTEXTNEST_AUTO_CAPTURE"],
    {
      normalize: (s) => s.trim().toLowerCase(),
      accept: (s) => TRUTHY_VALUES.includes(s) || FALSY_VALUES.includes(s),
    },
  );

  // Accept the unpin sentinel "" or a shape-valid alias; a malformed alias
  // ("my vault", "a/b", "..") is skipped so it can't reach ctx as a bad
  // --vault arg. Registry membership is verified by the config command.
  const rawVault = pick(
    "vault",
    ["CLAUDE_PLUGIN_OPTION_VAULT", "CONTEXTNEST_VAULT_ALIAS"],
    {
      normalize: (s) => s.trim(),
      accept: (s) => s === "" || ALIAS_PATTERN.test(s),
    },
  );

  return {
    // Invalid values are skipped per layer (see pick), so this only ever
    // yields a known mode or the "search" default — never a bogus string.
    retrievalMode:
      pick(
        "retrieval_mode",
        ["CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE", "CONTEXTNEST_RETRIEVAL_MODE"],
        {
          normalize: (s) => s.trim().toLowerCase(),
          accept: (s) => VALID_RETRIEVAL_MODES.includes(s),
        },
      ) || "search",
    // Default ON. Only a recognized falsy value disables it.
    autoCapture: rawAuto === undefined ? true : TRUTHY_VALUES.includes(rawAuto),
    // Pinned vault alias. Deliberately NOT named CONTEXTNEST_VAULT so it never
    // collides with the env var the ctx CLI itself consumes for resolution.
    vault: rawVault === undefined ? "" : rawVault,
    // Command used to invoke ctx. Trimmed; a blank value is skipped so it
    // falls back to the "ctx" default (which itself npx-falls-back on ENOENT).
    // Internal whitespace is allowed — execFileSync runs the whole string as
    // argv[0], so a path containing spaces is legitimate.
    ctxCommand:
      pick(
        "ctx_command",
        ["CLAUDE_PLUGIN_OPTION_CTX_COMMAND", "CONTEXTNEST_CTX_COMMAND"],
        { normalize: (s) => s.trim(), accept: (s) => s.length > 0 },
      ) || "ctx",
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
 * True when `alias` names a vault that is registered AND present on disk.
 * `getConfig` only checks the alias *shape*; this is the registry check that
 * needs the live `ctx` registry, so it lives with the exec-taking helpers.
 *
 * @param {string} alias
 * @param {(args:string[]) => any} exec
 */
export function isVaultRegistered(alias, exec) {
  if (!alias) return false;
  return listVaults(exec).some((v) => v.alias === alias && v.exists !== false);
}

/**
 * Decide which vault aliases the cheap (non-agent) tiers should search.
 *
 *  - Pinned alias, registered → just that alias.
 *  - Pinned alias, NOT registered (stale/removed pin) → ignore the pin and
 *    behave as unpinned, rather than passing ctx a bad --vault that resolves to
 *    nothing. session-start surfaces a warning so this isn't silent.
 *  - Unpinned + registry     → fan out across registered vaults (capped).
 *  - Unpinned + empty registry → a single null target, i.e. let ctx resolve the
 *                                 local/default vault with no --vault flag.
 *
 * @param {ReturnType<typeof getConfig>} config
 * @param {(args:string[]) => any} exec
 * @returns {(string|null)[]} list of alias targets (null = ctx default resolution)
 */
export function vaultTargets(config, exec) {
  const vaults = listVaults(exec).filter((v) => v.exists !== false);
  if (config.vault && vaults.some((v) => v.alias === config.vault)) {
    return [config.vault];
  }
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
