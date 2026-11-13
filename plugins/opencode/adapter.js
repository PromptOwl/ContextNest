/**
 * OpenCode adapter: maps OpenCode's in-process plugin hooks onto the vendored
 * shared core. Lives outside `core/` because `pnpm plugins:sync` owns `core/`.
 *
 * One per-session engine does the work; both plugin APIs feed it:
 *
 *   OpenCode 2 (`setup`)      session "prompt"  → engine.prompt
 *                             session "context" → engine.messages + engine.system
 *                             skill.transform   → the four skills
 *   OpenCode 1 (`server`)     chat.message      → engine.prompt
 *                             tool.execute.after→ engine.record + engine.shellCall
 *                             system.transform  → engine.system
 *                             config            → skills.paths
 *
 * engine.prompt runs the capture gate over the turns so far, then retrieval,
 * which hands over the job the gate just parked. Claude Code runs the same two
 * steps, Stop then UserPromptSubmit, at the same moment. So no idle event is
 * needed, and OpenCode 2 sends none to a plugin.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run as sessionStart } from "./core/session-start.js";
import { run as retrieve } from "./core/retrieve.js";
import { run as sweepCheck, SWEEP_CTX_TIMEOUT_MS } from "./core/sweep-check.js";
import { run as captureGate } from "./core/capture-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = join(HERE, "skills");
const RULES = join(HERE, "rules", "contextnest.md");

/** Shell tool names: `shell` in OpenCode 2, `bash` in OpenCode 1. */
const SHELL_TOOLS = new Set(["shell", "bash"]);
const MAX_LINES = 200;

function rules() {
  try {
    // The sync markers are for maintainers, not the model.
    return readFileSync(RULES, "utf-8").replace(/<!--[^>]*-->\r?\n?/g, "").trim();
  } catch {
    return "";
  }
}

const contextOf = (out) => out?.hookSpecificOutput?.additionalContext || "";
const textOf = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();

/** The text the user typed (OpenCode 1 parts), without parts other plugins injected. */
export const promptText = textOf;

const USER = (content) => ({ type: "user", message: { role: "user", content } });
const TOOL_USE = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use" }] } };

/**
 * OpenCode 2 context messages → the Claude-shaped transcript the capture gate
 * reads, plus every shell call that has a result.
 */
export function readMessages(messages) {
  const lines = [];
  const calls = [];
  const done = new Set();
  let userTurns = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const parts = Array.isArray(m?.content) ? m.content : [];
    if (m?.role === "user") {
      const text = textOf(parts);
      if (text) {
        userTurns++;
        lines.push(USER(text));
      }
    } else if (m?.role === "assistant") {
      const text = textOf(parts);
      if (text) lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
      for (const p of parts) {
        if (p?.type !== "tool-call") continue;
        lines.push(TOOL_USE);
        if (SHELL_TOOLS.has(p.name)) calls.push({ id: p.id, command: p.input?.command });
      }
    } else if (m?.role === "tool") {
      for (const p of parts) if (p?.type === "tool-result") done.add(p.id);
    }
  }
  return { lines: lines.slice(-MAX_LINES), userTurns, shellCalls: calls.filter((c) => done.has(c.id)) };
}

/**
 * `newExec(timeout?)` returns a fresh `ctx` runner. The server process lives for
 * the whole session and makeExec gives up for good after its first timeout, so
 * each step gets its own runner, as each hook process does elsewhere.
 *
 * @param {{env:NodeJS.ProcessEnv, newExec:(timeout?:number)=>Function, ledgerIo?:object}} deps
 */
export function createEngine({ env, newExec, ledgerIo = {} }) {
  // ponytail: per-session state lives in memory for the server's lifetime and is
  // never reaped; a few strings per session. Reap on session delete if it grows.
  const sessions = new Map();
  const get = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, { overview: null, turn: "", sweep: [], swept: new Set(), lines: [], userTurns: 0 });
    }
    return sessions.get(id);
  };

  const engine = {
    /** A prompt was submitted: close the last turn, then retrieve for this one. */
    prompt(id, text) {
      const s = get(id);
      captureGate({
        input: { session_id: id },
        env,
        readTranscript: () => ({ lines: s.lines.map((l) => JSON.stringify(l)), userTurns: s.userTurns }),
        ledgerIo,
      });
      if (text) {
        s.userTurns++;
        engine.record(id, USER(text));
      }
      s.sweep = [];
      // Kept for every model call of this turn, replaced by the next prompt.
      s.turn = contextOf(retrieve({ input: { session_id: id, prompt: text }, env, exec: newExec(), ledgerIo }));
    },

    record(id, line) {
      const s = get(id);
      s.lines.push(line);
      if (s.lines.length > MAX_LINES) s.lines.shift();
    },

    /** A shell call finished: sweep after a `ctx update`, once per call. Returns the report. */
    shellCall(id, callId, command) {
      const s = get(id);
      if (callId != null) {
        if (s.swept.has(callId)) return "";
        s.swept.add(callId);
      }
      const report = contextOf(
        sweepCheck({ input: { tool_input: { command } }, env, exec: newExec(SWEEP_CTX_TIMEOUT_MS) }),
      );
      if (report) s.sweep.push(report);
      return report;
    },

    /** OpenCode 2: the whole conversation, before each model call. */
    messages(id, messages) {
      const s = get(id);
      const { lines, userTurns, shellCalls } = readMessages(messages);
      s.lines = lines;
      s.userTurns = userTurns;
      for (const call of shellCalls) engine.shellCall(id, call.id, call.command);
    },

    /** System texts for this model call: overview + rules (once per session), retrieval, sweep reports. */
    system(id) {
      const s = get(id);
      if (s.overview === null) {
        s.overview = [contextOf(sessionStart({ env, exec: newExec() })), rules()].filter(Boolean).join("\n\n");
      }
      return [s.overview, s.turn, ...s.sweep].filter(Boolean);
    },
  };
  return engine;
}

/** The skills, parsed for OpenCode 2's skill editor. */
export function readSkills(dir = SKILLS_DIR) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const path = join(dir, e.name, "SKILL.md");
        const raw = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
        const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        const field = (k) => m?.[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1].trim();
        return { id: e.name, name: field("name") || e.name, description: field("description") || "", path, content: m ? m[2] : raw };
      });
  } catch {
    return [];
  }
}

/** OpenCode 2 plugin body. */
export async function setupV2(ctx, deps) {
  const engine = createEngine(deps);
  const skills = readSkills();
  await ctx.skill.transform((editor) => {
    for (const skill of skills) editor.add(skill);
  });
  await ctx.session.hook("prompt", (e) => engine.prompt(e?.sessionID, String(e?.prompt?.text ?? "").trim()));
  const addSystem = (e) => {
    if (!e?.sessionID || !Array.isArray(e.system)) return;
    if (Array.isArray(e.messages)) engine.messages(e.sessionID, e.messages);
    for (const text of engine.system(e.sessionID)) e.system.push({ type: "text", text });
  };
  await ctx.session.hook("context", addSystem);
  // Compaction runs its own model call; without this its summary loses the rules.
  await ctx.session.hook("compaction", addSystem);
}

/** OpenCode 1 hooks. */
export function hooksV1(deps) {
  const engine = createEngine(deps);
  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(SKILLS_DIR)) config.skills.paths.push(SKILLS_DIR);
    },
    "chat.message": async (input, output) => engine.prompt(input?.sessionID, promptText(output?.parts)),
    "experimental.chat.system.transform": async (input, output) => {
      if (!input?.sessionID || !Array.isArray(output?.system)) return;
      output.system.push(...engine.system(input.sessionID));
    },
    "tool.execute.after": async (input) => {
      engine.record(input?.sessionID, TOOL_USE);
      if (SHELL_TOOLS.has(input?.tool)) engine.shellCall(input.sessionID, input.callID, input.args?.command);
    },
  };
}
