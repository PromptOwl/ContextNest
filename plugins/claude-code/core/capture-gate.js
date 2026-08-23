/**
 * Stop handler — gate that decides whether the vault should be touched at all.
 *
 * It decides, but it does NOT act. Returning `{decision:"block"}` would hold the
 * turn open while a subagent reads the vault, and the user would sit through it
 * every time the gate fired. Instead the job is parked in the session ledger and
 * the turn ends immediately; the next UserPromptSubmit drains the queue and
 * dispatches a *background* subagent, so the vault work overlaps the user's next
 * request rather than delaying the end of their last one.
 *
 * The only thing this hook returns is a `systemMessage`, which renders in the
 * transcript without blocking, so the user can see that something was queued.
 * Note that Stop's own `additionalContext` is metadata appended after the
 * model's message — the model does not act on it — so it is deliberately unused
 * here. UserPromptSubmit's `additionalContext` is the field that dispatches.
 *
 * What gets queued depends on the signal:
 *
 *   change  → the user corrected something. Queue the curator, which sweeps
 *             the whole vault so the correction lands in *every* node that
 *             carries the stale fact, not just the first search hit.
 *   capture → something may be worth keeping. Queue the capture agent, which
 *             walks the capture ladder and (in the default `propose` mode)
 *             proposes rather than writes.
 *
 * Loop safety: nothing blocks any more, so there is no recursion to guard
 * against. The `stop_hook_active` check is kept because it stays correct and
 * costs a line — it also means a fallback to blocking would not reintroduce a
 * loop.
 *
 * Noise control, in the order the signals are tested:
 *   1. Explicit user intent ("remember this", "actually it's Y") always gates,
 *      and always bypasses the cooldown.
 *   2. Otherwise the turn must be substantive AND the session must be out of
 *      its cooldown window (see ledger.js). This is what stops the gate firing
 *      on every tool-using turn, which is what it used to do.
 * Set CONTEXTNEST_CAPTURE_ALWAYS=1 to bypass 2 (kept for debugging).
 *
 * Pure core: run({input, env, readTranscript, ledgerIo}) returns the Stop output
 * object (or null to say nothing). The readers are injected for testability.
 */

import { getConfig, isMain, readStdin, safeJson } from "./lib.js";
import {
  correctionIntent,
  countUserTurns,
  explicitCaptureIntent,
  lastUserMessage,
} from "./signals.js";
import { DEFAULT_MIN_TURNS, inCooldown, loadLedger, parkJob } from "./ledger.js";
import { readFileSync } from "node:fs";

const LADDER = [
  "Walk the capture ladder and stop at the first rung that resolves:",
  "(1) can you state it as a headline plus one 'why it matters' sentence?",
  "(2) will both still be true next month — if not, is it worth an as-of date?",
  "(3) is it already in the vault?",
  "(4) can an existing node take one more sentence instead?",
  "(5) is it just a tag or title?",
  "(6) only then, the smallest possible new node.",
].join(" ");

/**
 * These read as next-turn directives, not end-of-turn ones: they are parked by
 * the Stop hook and handed to the model by the following UserPromptSubmit. Both
 * ask for background dispatch — the whole point is that the user's current
 * request is answered first and the vault work runs alongside it.
 */
const BACKGROUND = [
  "Run it in the background (the agent is declared `background: true`) and answer",
  "the user's current request first — they must not wait on the vault.",
].join(" ");

/** What the model is told to do when the previous turn produced possible new knowledge. */
export function captureReason(mode) {
  const posture =
    mode === "auto"
      ? "to persist anything genuinely worth keeping from that turn."
      : "to review that turn for anything worth keeping. It must NOT write: it " +
        "proposes in one line and waits for the user to say yes.";
  return [
    "A Context Nest capture pass was queued at the end of your previous turn.",
    `Invoke the \`contextnest-capture\` agent ${posture}`,
    BACKGROUND,
    LADDER,
    "If nothing clears the ladder, it says nothing at all.",
  ].join(" ");
}

/** What the model is told to do when the user corrected something last turn. */
export const CHANGE_REASON = [
  "A Context Nest correction sweep was queued at the end of your previous turn:",
  "the user corrected something the vault may record. Invoke the",
  "`contextnest-curator` agent. It must find EVERY node carrying the stale fact —",
  "not just the first search hit — and change them together, or report that the",
  "vault never asserted it.",
  BACKGROUND,
].join(" ");

/** The one-line, non-blocking note the user sees in the transcript. */
export function queuedMessage(kind) {
  return kind === "change"
    ? "Context Nest: queued a correction sweep — it runs with your next message."
    : "Context Nest: queued a capture pass — it runs with your next message.";
}

/**
 * Default transcript reader. Returns the tail for signal analysis plus the
 * whole-file user-turn count, which is the cooldown clock. Both come from one
 * read; `[]`/0 on any failure.
 *
 * @returns {{lines: string[], userTurns: number}}
 */
export function readTranscript(path, maxLines = 200) {
  if (!path) return { lines: [], userTurns: 0 };
  try {
    const all = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
    return { lines: all.slice(-maxLines), userTurns: countUserTurns(all) };
  } catch {
    return { lines: [], userTurns: 0 };
  }
}

/**
 * Did anything worth capturing likely happen since the last user prompt?
 * Heuristic over the transcript tail: a tool was used, or the assistant wrote a
 * substantial answer. This is now a *necessary* condition for an ambient gate
 * rather than a sufficient one — on its own it fires on nearly every turn.
 *
 * An unreadable transcript returns false: without evidence we stay quiet. The
 * old behaviour (favour capture) is exactly the bias being removed, and
 * explicit user intent is read from the payload path, not from here.
 *
 * Tradeoff: a raw substring test for `"tool_use"`, so an assistant message that
 * merely quotes the string reads as substantive. That only ever promotes a turn
 * to *eligible*; the cooldown still decides whether anything fires, so the
 * blast radius is nil. Kept from the original implementation deliberately.
 */
export function isSubstantive(lines) {
  if (!lines || lines.length === 0) return false;
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

/** Read the cooldown length, so a user who wants a chattier plugin can say so. */
function minTurns(env) {
  const raw = parseInt(env.CONTEXTNEST_CAPTURE_MIN_TURNS || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_TURNS;
}

/**
 * Decide whether to gate, and as what.
 *
 * @param {{transcript:{lines:string[], userTurns:number}, ledger:object, env:NodeJS.ProcessEnv, captureMode:string}} ctx
 * @returns {{gate:boolean, kind?:"capture"|"change", reason?:string, explicit?:boolean}}
 */
export function captureSignal({ transcript, ledger, env, captureMode }) {
  const { lines, userTurns } = transcript;
  const asked = lastUserMessage(lines);

  // A correction outranks a capture: when the user says "actually it's Y", the
  // right move is to fix what is already there, not to record a second version
  // of it alongside the first.
  if (correctionIntent(asked)) {
    return { gate: true, kind: "change", reason: CHANGE_REASON, explicit: true };
  }
  if (explicitCaptureIntent(asked)) {
    return { gate: true, kind: "capture", reason: captureReason(captureMode), explicit: true };
  }

  const always = /^(1|true|yes|on)$/i.test(env.CONTEXTNEST_CAPTURE_ALWAYS || "");
  if (!always) {
    if (!isSubstantive(lines)) return { gate: false };
    if (inCooldown(ledger, userTurns, minTurns(env))) return { gate: false };
  }
  return { gate: true, kind: "capture", reason: captureReason(captureMode), explicit: false };
}

/**
 * @param {{input:any, env:NodeJS.ProcessEnv, readTranscript?:Function, ledgerIo?:object}} ctx
 * @returns {object|null}
 */
export function run({ input, env, readTranscript: readT = readTranscript, ledgerIo = {} }) {
  const config = getConfig(env);
  if (config.captureMode === "off") return null; // capture disabled
  if (input?.stop_hook_active === true) return null; // vestigial: nothing blocks

  const transcript = readT(input?.transcript_path);
  const sessionId = input?.session_id;
  const ledger = loadLedger(sessionId, ledgerIo);

  // Stop fires at every turn end, including the one where a background agent
  // reported back. A job already queued for this turn must not be queued twice,
  // or the user gets the same directive on two consecutive prompts.
  if (ledger.pending && ledger.pending.turn === transcript.userTurns) return null;

  const signal = captureSignal({
    transcript,
    ledger,
    env,
    captureMode: config.captureMode,
  });
  if (!signal.gate) return null;

  // Stamp the cooldown only for ambient passes. Explicit intent must not start
  // a window, or asking twice in a row would silently ignore the second ask.
  const stamped = signal.explicit
    ? ledger
    : { ...ledger, lastGatedTurn: transcript.userTurns };

  parkJob(
    sessionId,
    stamped,
    { kind: signal.kind, reason: signal.reason, turn: transcript.userTurns },
    ledgerIo,
  );

  // No `decision` and no `continue: false`: the turn ends now. The only output
  // is the transcript note, so the user knows work is queued rather than lost.
  return { systemMessage: queuedMessage(signal.kind) };
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
