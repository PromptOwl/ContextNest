/**
 * SessionStart handler — prime the model with a compact vault overview.
 *
 * Runs `ctx vault list --json`. If ctx is unavailable, injects a one-line
 * warning instead of failing (a hook must never break the session). Otherwise
 * injects the registered vault aliases + descriptions, marks the pinned/default
 * one, names the vault found in the working directory (if any), and nudges the
 * model to use the vault before answering.
 *
 * On a fresh session it may also tell the USER (systemMessage) to run
 * /contextnest:setup when nothing is set up, or to update an outdated `ctx`.
 */

import {
  getConfig,
  ctxJson,
  cwdVault,
  isVaultRegistered,
  bundledCliPin,
  squish,
  withVault,
  runAsHook,
  isMain,
} from "./lib.js";

/**
 * What Claude does about a user with nothing connected. Bare `ctx` is the
 * CLI's own guided setup, but it needs an interactive terminal, which the
 * Bash tool is not — so Claude runs the plugin's setup instead. Says what
 * connecting does NOT do, because "register a nest" read as "upload my vault".
 */
const SETUP_HINT =
  "If the user asks to set up Context Nest, run the guided setup yourself (Claude Code: `/contextnest:setup`) " +
  "and recommend keeping the notes on this computer. Never run bare `ctx` to set up and never send the user to a terminal: " +
  "that setup needs an interactive terminal. Mention setup at most once per session, in one line, never in the middle of their task. " +
  "Connecting uploads nothing: local notes stay on this machine unless the user chooses to put them online.";

/** Shown to the user (not just Claude) at the start of a session when nothing is set up. */
export const SETUP_NOTICE =
  "Context Nest isn't set up yet. Run /contextnest:setup to give Claude a notes folder (about a minute).";

/** `x.y.z` → comparable number triple, or null. */
const semver = (s) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s ?? ""));
  return m ? m.slice(1).map(Number) : null;
};
const older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * @param {{input?:any, env:NodeJS.ProcessEnv, exec:Function, cliPin?:string|null}} ctx
 *   `cliPin`: the CLI version this plugin ships (its package.json); null skips the outdated check.
 * @returns {object|null}
 */
export function run({ input, env, exec, cliPin = bundledCliPin() }) {
  const config = getConfig(env);
  // Messages for the user. Only on a fresh session — resume, clear and compact
  // would repeat them mid-work — and never when the user turned hints off.
  const hintsOff = env.CONTEXTNEST_NO_HINTS && env.CONTEXTNEST_NO_HINTS !== "0";
  const notify = input?.source === "startup" && !hintsOff;
  const notices = [];

  // Probe availability + registry in one call.
  const probe = exec(["vault", "list", "--json"]);
  if (!probe || probe.status !== 0) {
    // No ctx and no npx (no Node, or a locked-down machine): the cloud MCP
    // path needs neither, so point there instead of at an install.
    return wrap(
      "Context Nest CLI (`ctx`) is not available, so vault auto-retrieval and " +
        `capture hooks are disabled this session. ${SETUP_HINT}`,
    );
  }

  const vaults = (() => {
    const v = ctxJson(() => probe, ["vault", "list", "--json"], []);
    return Array.isArray(v) ? v : [];
  })();

  // Naming the effective mode up front answers "did the plugin stop writing?"
  // for anyone whose legacy auto_capture:true now maps to propose.
  const lines = [
    `Context Nest is active for this session (capture: ${config.captureMode}; unclear nest: ${config.unclearNest === "default" ? "write to the default" : "ask the user"}).`,
  ];

  // A pin is only honoured if it still resolves to a registered vault; it may
  // have been removed or renamed since it was set. Warn loudly on a stale pin —
  // retrieval falls back to automatic selection (see vaultTargets).
  const pinnedIsRegistered = isVaultRegistered(config.vault, vaults);

  if (config.vault && !pinnedIsRegistered) {
    lines.push(
      `⚠ Pinned vault \`${config.vault}\` is not a registered vault (removed, renamed, or ` +
        `misspelled). Retrieval and capture fall back to automatic vault selection. Fix it with ` +
        `\`/contextnest:config vault <alias>\` (or re-register the vault with \`ctx vault add\`).`,
    );
  } else if (config.vault) {
    lines.push(`Pinned vault: \`${config.vault}\` (all queries/captures use it).`);
  }

  // The vault in the working directory is what auto-retrieval searches first
  // (see vaultTargets); say so, and whether it is also a registered alias.
  const local = cwdVault(exec, vaults);
  if (local) {
    const how = local.alias
      ? `registered as \`${local.alias}\``
      : "not registered — cited without an alias prefix";
    const rank = pinnedIsRegistered
      ? "the pinned vault takes precedence for auto-retrieval"
      : "searched first on every prompt";
    lines.push(`Working-directory vault: \`${local.path}\` (${how}; ${rank}).`);
  }

  // A vault named in the environment resolves without being registered; the
  // CLI's own first-run check counts that user as set up, and so does this.
  const envVault = Boolean(env.CONTEXTNEST_VAULT || env.CONTEXTNEST_VAULT_PATH);
  if (vaults.length === 0) {
    if (local) {
      lines.push("No vaults are registered; `ctx` resolves the working-directory vault above.");
    } else if (envVault) {
      lines.push("No vaults are registered; `ctx` uses the vault set by CONTEXTNEST_VAULT / CONTEXTNEST_VAULT_PATH.");
    } else if (config.setup === "declined") {
      lines.push(
        "No nest is connected: the user chose not to set up Context Nest for now. Run `/contextnest:setup` only if they ask.",
      );
    } else if (config.setup === "done") {
      // Set up over MCP only: no ctx vault, the nest is reached through its tools.
      lines.push(
        "No vaults are registered with `ctx`. Use the Context Nest MCP tools if they are connected; if the user asks to connect a nest, run `/contextnest:setup`.",
      );
    } else {
      lines.push(`No vaults are registered, so no nest is connected yet. ${SETUP_HINT}`);
      if (notify) notices.push(SETUP_NOTICE);
    }
  } else {
    lines.push("Registered vaults:");
    for (const v of vaults) {
      const flags = [];
      if (v.alias === config.vault) flags.push("pinned");
      if (v.isDefault) flags.push("default");
      if (v.exists === false) flags.push("missing");
      const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
      const desc = v.description ? ` — ${squish(v.description, 80)}` : "";
      lines.push(`- \`${v.alias}\`${desc}${suffix}`);
    }
    if (!config.vault) {
      lines.push(
        "No vault is pinned, so the contextnest-retriever and contextnest-capture agents choose the relevant vault(s) by description.",
      );
    }
  }

  // A server the user signed in to but never registered has nests that are invisible here.
  // Said as a fact for the model to relay; the model is not asked to run anything.
  const logins = hintsOff ? [] : ctxJson(exec, ["login", "--list", "--json"], []);
  if (Array.isArray(logins)) {
    for (const l of logins) {
      if (!l || typeof l.url !== "string" || (Array.isArray(l.usedBy) && l.usedBy.length > 0)) continue;
      // The file is the user's, but it ends up in model context: accept only what ctx itself would write.
      if (!/^https?:\/\/[^\s`]+$/.test(l.url)) continue;
      if (l.account != null && !/^[A-Za-z0-9._@+-]{1,64}$/.test(String(l.account))) continue;
      const url = squish(l.url.replace(/`/g, "'"), 120);
      lines.push(
        `The user is logged in to ${url}${l.account ? ` (account ${squish(String(l.account).replace(/`/g, "'"), 40)})` : ""} ` +
          "but has no vault registered for it, so its nests are not listed above. If they ask about it, tell them to run " +
          `\`ctx vault add <alias> --url ${url}/mcp\` themselves.`,
      );
    }
  }

  // The vault captures land in: the pinned one, else the working-directory
  // one. Only that vault's structure rules are shown — fanning out over every
  // registered vault would cost one `ctx` call each on every session start.
  const target = config.vault && pinnedIsRegistered ? { alias: config.vault } : local;
  if (target) lines.push(...structureLines(exec, withVault(["structure", "--json"], target.alias)));

  // Nothing connected: the setup hint is the whole message.
  if (vaults.length > 0 || local || envVault) {
    lines.push(
      "Query the vault before answering domain questions (`ctx query`/`/contextnest:recall`); cite nodes as `vault:id`.",
    );
  }

  // The user's own global `ctx` wins over the copy shipped with the plugin, so
  // an old one silently costs features. The call takes the same path the hooks
  // do: the bundled or npx CLI answers with the pin or newer and says nothing.
  if (notify && cliPin) {
    const res = exec(["--version"]);
    const have = res?.status === 0 ? semver(res.stdout) : null;
    const want = semver(cliPin);
    if (have && want && older(have, want) < 0) {
      notices.push(
        `Your \`ctx\` is ${have.join(".")}; this plugin expects ${cliPin} or newer. ` +
          "Update it with: npm i -g @promptowl/contextnest-cli@latest",
      );
    }
  }

  return wrap(lines.join("\n"), notices);
}

/** Folder rules shown before eliding the rest to `ctx structure`. */
const MAX_RULE_LINES = 15;

/**
 * A compact blueprint of the vault's structure rules (§11.1), or nothing when
 * it has none — or when `ctx` predates the command (non-zero exit).
 */
function structureLines(exec, args) {
  // Rule text is written by the vault's owner — for a pinned remote nest,
  // someone else. One line per value and a hard length cap, so it can never
  // break out of its bullet into instructions of its own.
  const clean = (value, max = 60) => squish(String(value).replace(/`/g, "'"), max);
  const s = ctxJson(exec, args, null);
  if (!s || typeof s !== "object" || !Array.isArray(s.folders) || s.folders.length === 0) return [];
  const mode = s.enforce ? "enforced — writes that break them are refused" : "report-only";
  const lines = [`Structure rules for this vault (${mode}${s.closed ? "; closed: only these folders may exist" : ""}):`];
  for (const f of s.folders.slice(0, MAX_RULE_LINES)) {
    const parts = [];
    if (Array.isArray(f.types)) parts.push(f.types.length ? `types ${clean(f.types.join("/"))}` : "no documents directly");
    if (f.folder_name) parts.push(`folder names ${clean(f.folder_name)}`);
    if (f.file_name) parts.push(`file names ${clean(f.file_name)}`);
    if (f.template) parts.push(`template ${clean(f.template, 40)}`);
    const files = Object.keys(f.files ?? {});
    if (files.length) parts.push(`required files ${clean(files.join(", "))}`);
    if (f.required) parts.push("required");
    lines.push(`- \`${clean(f.pattern)}\`${parts.length ? ` — ${parts.join("; ")}` : ""}`);
  }
  if (s.folders.length > MAX_RULE_LINES) {
    lines.push(`- … ${s.folders.length - MAX_RULE_LINES} more — run \`ctx structure\``);
  }
  lines.push(
    "Before writing a node, run `ctx structure --folder <folder> --json` for its allowed types, file-name format and template body (file names come from titles).",
  );
  return lines;
}

/** `notices` go to the user as a systemMessage; the context goes to Claude. */
function wrap(additionalContext, notices = []) {
  return {
    ...(notices.length ? { systemMessage: notices.join("\n") } : {}),
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

if (isMain(import.meta.url)) {
  runAsHook(run);
}
