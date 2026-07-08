/**
 * Stop handler — gate that triggers the capture agent at end of turn.
 *
 * Returning `{decision:"block", reason}` is the documented, loop-safe way to make
 * the model do one more thing before the turn ends — here, invoke the
 * contextnest-capture agent (which has Bash + ctx) to persist new knowledge.
 *
 * Loop safety: when the model stops *again* after the capture, Claude Code sets
 * `stop_hook_active: true` on the Stop payload, which we always allow — so this
 * can never recurse.
 *
 * Cost control: we only block on a "substantive" turn (tools were used, or the
 * assistant produced a long answer). Pure short conversational turns are allowed
 * straight through. Set CONTEXTNEST_CAPTURE_ALWAYS=1 to block on every turn.
 *
 * Pure core: run({input, env, readTail}) returns the Stop output object (or null
 * to allow the stop). `readTail` is injected for testability.
 */

import { getConfig, isMain, readStdin, safeJson } from "./lib.js";
import { readFileSync } from "node:fs";

const REASON = [
  "Before ending: invoke the `contextnest-capture` agent to persist any new",
  "facts, decisions, gotchas, answers, or references uncovered this turn into the",
  "Context Nest vault (it dedupes with `ctx search` first and stays silent if",
  "nothing is worth keeping). Then finish.",
].join(" ");

/** Default transcript reader: last `maxLines` raw JSONL lines, or [] on failure. */
export function readTranscriptTail(path, maxLines = 200) {
  if (!path) return [];
  try {
    const text = readFileSync(path, "utf-8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Did anything worth capturing likely happen since the last user prompt?
 * Heuristic over the transcript tail: a tool was used, or the assistant wrote a
 * substantial answer. When the transcript can't be read we favour capture
 * (return true) — the capture agent itself is the final arbiter and stays quiet
 * when there's nothing to save.
 */
export function isSubstantive(lines) {
  if (!lines || lines.length === 0) return true;
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/"(role|type)"\s*:\s*"user"/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const recent = lines.slice(start);
  if (recent.some((l) => l.includes('"tool_use"') || l.includes('"toolUse"'))) {
    return true;
  }
  const assistantChars = recent
    .filter((l) => /"(role|type)"\s*:\s*"assistant"/.test(l))
    .reduce((n, l) => n + l.length, 0);
  return assistantChars > 600;
}

/**
 * @param {{input:any, env:NodeJS.ProcessEnv, readTail?:Function}} ctx
 * @returns {object|null}
 */
export function run({ input, env, readTail = readTranscriptTail }) {
  const config = getConfig(env);
  if (!config.autoCapture) return null; // capture disabled
  if (input?.stop_hook_active === true) return null; // loop guard — capture already ran

  const always = /^(1|true|yes|on)$/i.test(env.CONTEXTNEST_CAPTURE_ALWAYS || "");
  if (!always && !isSubstantive(readTail(input?.transcript_path))) return null;

  return { decision: "block", reason: REASON };
}

if (isMain(import.meta.url)) {
  // Dedicated shell: capture-gate needs a transcript reader, and must always
  // exit 0 so a Stop hook never wedges the session.
  (async () => {
    try {
      const raw = await readStdin();
      const input = raw ? safeJson(raw, {}) : {};
      const out = run({ input, env: process.env });
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (err) {
      process.stderr.write(`[contextnest] capture-gate error: ${err?.message || err}\n`);
    }
    process.exit(0);
  })();
}
