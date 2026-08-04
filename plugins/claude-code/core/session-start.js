/**
 * SessionStart handler — prime the model with a compact vault overview.
 *
 * Runs `ctx vault list --json`. If ctx is unavailable, injects a one-line
 * warning instead of failing (a hook must never break the session). Otherwise
 * injects the registered vault aliases + descriptions, marks the pinned/default
 * one, and nudges the model to use the vault before answering.
 */

import {
  getConfig,
  ctxJson,
  isVaultRegistered,
  squish,
  runAsHook,
  isMain,
} from "./lib.js";

/**
 * @param {{input:any, env:NodeJS.ProcessEnv, exec:Function}} ctx
 * @returns {object|null}
 */
export function run({ env, exec }) {
  const config = getConfig(env);

  // Probe availability + registry in one call.
  const probe = exec(["vault", "list", "--json"]);
  if (!probe || probe.status !== 0) {
    return wrap(
      "Context Nest CLI (`ctx`) is not available, so vault auto-retrieval and " +
        "capture are disabled this session. Install it with " +
        "`npm i -g @promptowl/contextnest-cli` to enable them.",
    );
  }

  const vaults = (() => {
    const v = ctxJson(() => probe, ["vault", "list", "--json"], []);
    return Array.isArray(v) ? v : [];
  })();

  const lines = ["Context Nest is active for this session."];

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

  if (vaults.length === 0) {
    lines.push(
      "No vaults are registered; `ctx` will resolve a local `.context` vault from the working directory if present.",
    );
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

  lines.push(
    "Query the vault before answering domain questions (`ctx query`/`/contextnest:recall`); cite nodes as `vault:id`.",
  );

  return wrap(lines.join("\n"));
}

function wrap(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

if (isMain(import.meta.url)) {
  runAsHook(run);
}
