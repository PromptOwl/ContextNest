#!/usr/bin/env node
/**
 * Antigravity hook adapter: `node ./hooks/antigravity.js <Event>`.
 *
 * Translates Antigravity's hook contract (camelCase stdin, `injectSteps`
 * stdout — https://antigravity.google/docs/hooks) into calls to the vendored
 * shared core, which speaks Claude Code's (snake_case stdin,
 * `hookSpecificOutput.additionalContext`). Lives outside `core/` because
 * `core/` is a vendored copy that `pnpm plugins:sync` owns.
 *
 * Event mapping:
 *   SessionStart  → session-start   (vault overview + structure blueprint)
 *   PreInvocation → retrieve        (on a fresh prompt; otherwise just drains a parked job)
 *   PostToolUse   → sweep-check     (output must be `{}`, so the report is
 *                                    parked and handed over by the next PreInvocation)
 *   Stop          → capture-gate    (parks a capture/change job in the ledger)
 */

import { closeSync, openSync, readFileSync, readSync, fstatSync } from "node:fs";
import { getConfig, isMain, makeExec, readStdin, safeJson } from "../core/lib.js";
import { clearPending, loadLedger, parkJob } from "../core/ledger.js";
import { run as sessionStart } from "../core/session-start.js";
import { run as retrieve } from "../core/retrieve.js";
import { run as sweepCheck, SWEEP_CTX_TIMEOUT_MS } from "../core/sweep-check.js";
import { run as captureGate } from "../core/capture-gate.js";

// ponytail: the transcript record schema is undocumented; `USER_INPUT` +
// `content` is the only record shape relied on. Everything else passes through
// raw, so the ambient (non-explicit) capture heuristic may under-fire until the
// assistant/tool record types are mapped too.
function userText(record) {
  if (record?.type !== "USER_INPUT") return "";
  const { content } = record;
  if (typeof content === "string") return content.trim();
  // Structured content: keep the text parts only — raw JSON is noise to search and the gate.
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
    .join("\n")
    .trim();
}

/** Last JSONL record of a file, reading only its tail. */
export function lastRecord(path, tailBytes = 256 * 1024) {
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf-8").split(/\r?\n/).filter((l) => l.trim());
    return lines.length ? safeJson(lines[lines.length - 1], null) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** capture-gate reader: Antigravity user records rewritten into the shape the core counts. */
export function readTranscript(path, maxLines = 200) {
  if (!path) return { lines: [], userTurns: 0 };
  try {
    let userTurns = 0;
    const all = readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((line) => {
        const text = userText(safeJson(line, null));
        if (!text) return line;
        userTurns++;
        return JSON.stringify({ type: "user", message: { role: "user", content: text } });
      });
    return { lines: all.slice(-maxLines), userTurns };
  } catch {
    return { lines: [], userTurns: 0 };
  }
}

/** Both jobs' directives in one slot. Keeps a known turn, so the capture gate's per-turn dedupe still holds. */
const joinJobs = (older, newer) => ({
  kind: newer.kind,
  reason: `${older.reason}\n\n${newer.reason}`,
  turn: newer.turn ?? older.turn,
  seeds: newer.seeds?.length ? newer.seeds : older.seeds,
});

const inject = (text) => (text ? { injectSteps: [{ systemMessage: text }] } : {});
const contextOf = (out) => out?.hookSpecificOutput?.additionalContext;

/**
 * @param {string} event Antigravity hook event name
 * @param {{input:any, env:NodeJS.ProcessEnv, exec:Function, ledgerIo?:object}} ctx
 * @returns {object} the hook's stdout JSON
 */
export function run(event, { input, env, exec, ledgerIo = {} }) {
  const sessionId = input?.conversationId;

  if (event === "SessionStart") return inject(contextOf(sessionStart({ env, exec })));

  if (event === "PreInvocation") {
    // PreInvocation fires before every model call of a turn, not once per
    // prompt. Search only when the user's message is the newest record; later
    // calls in the same turn still drain whatever was parked (e.g. a sweep).
    const prompt = userText(lastRecord(input?.transcriptPath));
    if (prompt) {
      return inject(contextOf(retrieve({ input: { session_id: sessionId, prompt }, env, exec, ledgerIo })));
    }
    // Not retrieve(): with no prompt it would still re-inject the agent-mode
    // directive on every model call. Hand over the parked job, once.
    const ledger = loadLedger(sessionId, ledgerIo);
    if (!ledger.pending) return {};
    clearPending(sessionId, ledger, ledgerIo);
    return inject(ledger.pending.reason);
  }

  if (event === "PostToolUse") {
    const command = input?.toolCall?.args?.CommandLine;
    const out = sweepCheck({ input: { tool_input: { command } }, env, exec });
    const report = contextOf(out);
    if (report) {
      // Join any job already waiting rather than replace it: the slot holds one.
      const ledger = loadLedger(sessionId, ledgerIo);
      const job = { kind: "change", reason: report, turn: null, seeds: [] };
      parkJob(sessionId, ledger, ledger.pending ? joinJobs(ledger.pending, job) : job, ledgerIo);
    }
    return {};
  }

  if (event === "Stop") {
    // The capture gate's parkJob replaces the slot; a sweep report parked by a
    // last-step `ctx update` (no PreInvocation since) must survive it.
    const parked = loadLedger(sessionId, ledgerIo).pending;
    captureGate({
      input: { transcript_path: input?.transcriptPath, session_id: sessionId },
      env,
      readTranscript,
      ledgerIo,
    });
    const ledger = loadLedger(sessionId, ledgerIo);
    if (parked && ledger.pending && ledger.pending.reason !== parked.reason) {
      parkJob(sessionId, ledger, joinJobs(parked, ledger.pending), ledgerIo);
    }
    // `decision` is required; anything but "continue" lets the agent stop.
    return { decision: "stop" };
  }

  return {};
}

if (isMain(import.meta.url)) {
  (async () => {
    const event = process.argv[2];
    // Stop requires `decision`, so even a crash must answer with one.
    let out = event === "Stop" ? { decision: "stop" } : {};
    try {
      const raw = await readStdin();
      const input = raw ? safeJson(raw, {}) : {};
      const env = process.env;
      const timeout = event === "PostToolUse" ? SWEEP_CTX_TIMEOUT_MS : undefined;
      const exec = makeExec(getConfig(env), { cwd: input.workspacePaths?.[0] || process.cwd(), env, timeout });
      out = run(event, { input, env, exec });
    } catch (err) {
      process.stderr.write(`[contextnest] antigravity ${event} hook error: ${err?.message || err}\n`);
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  })();
}
