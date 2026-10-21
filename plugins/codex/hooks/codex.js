/**
 * Codex hook adapter. hooks.json calls `main(<Event>)` through `node -e`, so the
 * command reads PLUGIN_ROOT from the environment on every platform.
 *
 * Codex speaks Claude Code's hook contract (snake_case stdin, `Bash` with
 * `tool_input.command`, `hookSpecificOutput.additionalContext`), so three
 * events go straight to the vendored shared core. Only these differ:
 *   SessionStart → also injects rules/contextnest.md, because a Codex plugin
 *                  has no rules file and the hook text names Claude agents.
 *   Stop         → reads Codex's rollout transcript, and answers nothing:
 *                  Codex shows a `systemMessage` as a warning. The parked
 *                  job still reaches the model with the next prompt.
 * Lives outside `core/` because `pnpm plugins:sync` owns `core/`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAsHook } from "../core/lib.js";
import { run as sessionStart } from "../core/session-start.js";
import { run as retrieve } from "../core/retrieve.js";
import { run as sweepCheck } from "../core/sweep-check.js";
import { run as captureGate, transcriptReader } from "../core/capture-gate.js";

const RULES = join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "contextnest.md");

const text = (content) =>
  (Array.isArray(content) ? content : [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n")
    .trim();

// ponytail: Codex calls the rollout format unstable. Only three record shapes
// are read; anything else is dropped, so a format change makes the ambient
// capture heuristic quieter, never noisier.
const TOOL_CALLS = new Set(["function_call", "local_shell_call", "custom_tool_call"]);

/** One Codex rollout record → the Claude-shaped record the capture gate reads, or null. */
export function toClaude(record) {
  const p = record?.payload;
  // The typed prompt. Response-item user messages also carry injected
  // AGENTS.md and environment context, so they are not counted as turns.
  if (record?.type === "event_msg" && p?.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
    return { type: "user", message: { role: "user", content: p.message.trim() } };
  }
  if (record?.type !== "response_item") return null;
  if (TOOL_CALLS.has(p?.type)) return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use" }] } };
  if (p?.type === "message" && p.role === "assistant") {
    return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: text(p.content) }] } };
  }
  return null;
}

export const readTranscript = transcriptReader(toClaude);

function rules() {
  try {
    return readFileSync(RULES, "utf-8");
  } catch {
    return "";
  }
}

/**
 * @param {string} event Codex hook event name
 * @param {{input:any, env:NodeJS.ProcessEnv, exec:Function, ledgerIo?:object}} ctx
 * @returns {object|null} the hook's stdout JSON, or null for none
 */
export function run(event, { input, env, exec, ledgerIo = {} }) {
  if (event === "SessionStart") {
    const overview = sessionStart({ env, exec })?.hookSpecificOutput?.additionalContext;
    const additionalContext = [overview, rules()].filter(Boolean).join("\n\n");
    return additionalContext ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } } : null;
  }
  if (event === "UserPromptSubmit") return retrieve({ input, env, exec, ledgerIo });
  if (event === "PostToolUse") return sweepCheck({ input, env, exec });
  if (event === "Stop") {
    captureGate({ input, env, readTranscript, ledgerIo });
    return null;
  }
  return null;
}

/** IO shell: `node -e "import(...).then(m => m.main('Stop'))"`. */
export function main(event) {
  return runAsHook((ctx) => run(event, ctx));
}
