/**
 * Codex adapter (plugins/codex/hooks/codex.js): the pure run() is called with
 * a fake exec and in-memory ledger; one test spawns the real hooks.json
 * command to prove the `node -e` + PLUGIN_ROOT wiring loads the adapter.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run, readTranscript } from "../codex/hooks/codex.js";
import { MAX_LIST_SCAN } from "../shared/core/lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "codex");

// getConfig() reads settings files from the project dir and home dir; keep a
// developer's own pinned vault out of these assertions (see core.unit.test.ts).
let SANDBOX: string;
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "cn-codex-"));
  process.env.HOME = SANDBOX;
  process.env.USERPROFILE = SANDBOX;
});
afterAll(() => {
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});
const env = () => ({ CLAUDE_PROJECT_DIR: SANDBOX });

function fakeLedgerIo() {
  const files: Record<string, string> = {};
  return {
    homedir: "/fake-home",
    read: (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    write: (p: string, data: string) => {
      files[p] = data;
    },
    mkdir: () => undefined,
  };
}

function fakeExec(routes: [string, unknown][], calls: string[] = []) {
  return (args: string[]) => {
    const key = args.join(" ");
    calls.push(key);
    for (const [match, val] of routes) {
      if (key.includes(match)) {
        return { status: 0, stdout: typeof val === "string" ? val : JSON.stringify(val), stderr: "" };
      }
    }
    return { status: 0, stdout: "[]", stderr: "" };
  };
}

/** Write a Codex-style rollout (CRLF, to prove line endings don't matter). */
function rollout(records: object[]): string {
  const path = join(mkdtempSync(join(SANDBOX, "tx-")), "rollout.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\r\n") + "\r\n");
  return path;
}
const typed = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
const injected = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const toolCall = { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } };
const context = (out: any): string => out?.hookSpecificOutput?.additionalContext ?? "";

describe("codex adapter", () => {
  it("SessionStart: injects the vault overview and the operating rules", () => {
    const exec = fakeExec([["vault list", [{ alias: "eng", exists: true, description: "Engineering" }]]]);
    const text = context(run("SessionStart", { input: {}, env: env(), exec }));
    expect(text).toContain("eng");
    expect(text).toContain("`contextnest-curator` agent → `contextnest-curate` skill");
  });

  it("UserPromptSubmit: searches the vault with the prompt", () => {
    const calls: string[] = [];
    const exec = fakeExec([["search", [{ id: "nodes/auth", title: "Auth design", type: "document" }]]], calls);
    const out = run("UserPromptSubmit", {
      input: { session_id: "s1", prompt: "how does auth work?" },
      env: env(),
      exec,
      ledgerIo: fakeLedgerIo(),
    });
    expect(calls.some((c) => c.startsWith("search how does auth work?"))).toBe(true);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(context(out)).toContain("nodes/auth");
  });

  it("PostToolUse: a ctx update on Bash reports nodes still carrying the old value", () => {
    const exec = fakeExec([
      ["vault list", [{ alias: "eng", exists: true }]],
      ["read nodes/a --raw --vault eng", "---\nt: x\n---\nSessions live in Postgres."],
      ["history nodes/a --json --vault eng", { versions: [{ version: 1 }, { version: 2 }] }],
      ["reconstruct nodes/a 1 --vault eng", "---\nt: x\n---\nSessions live in Redis."],
      [`search redis --json --limit ${MAX_LIST_SCAN} --vault eng`, [{ id: "nodes/pitch" }]],
      ["read nodes/pitch --raw --vault eng", "---\nt: x\n---\nWe brag about Redis speed."],
    ]);
    const input = { session_id: "s2", tool_name: "Bash", tool_input: { command: "ctx --vault eng update nodes/a --body x" } };
    expect(context(run("PostToolUse", { input, env: env(), exec }))).toContain('eng:nodes/pitch still contains "redis"');
  });

  it("Stop: answers nothing, and the next prompt receives the parked capture", () => {
    const ledgerIo = fakeLedgerIo();
    const transcript_path = rollout([injected("# AGENTS.md instructions"), typed("remember this: we deploy on Fridays")]);
    expect(run("Stop", { input: { session_id: "s3", transcript_path }, env: env(), exec: fakeExec([]), ledgerIo })).toBeNull();

    const next = run("UserPromptSubmit", {
      input: { session_id: "s3", prompt: "thanks" },
      env: { ...env(), CONTEXTNEST_RETRIEVAL_MODE: "off" },
      exec: fakeExec([]),
      ledgerIo,
    });
    expect(context(next)).toMatch(/capture pass was queued/);
  });

  it("readTranscript: counts typed prompts only, maps tool calls, drops the rest", () => {
    const path = rollout([injected("<environment_context>"), typed("a"), toolCall, typed("b"), { type: "turn_context" }]);
    const { lines, userTurns } = readTranscript(path);
    expect(userTurns).toBe(2);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"tool_use"');
    expect(readTranscript(undefined)).toEqual({ lines: [], userTurns: 0 });
  });

  it("hooks.json: every command loads the adapter through PLUGIN_ROOT and exits 0", () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf-8")).hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    const commands = Object.entries<any>(hooks).flatMap(([event, groups]) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => [event, h.command])),
    );
    for (const [event, command] of commands) expect(command).toContain(`m.main('${event}')`);

    // Stop with an empty payload: the real shell must load and stay silent.
    const stop = commands.find(([event]) => event === "Stop")![1];
    const stdout = execSync(stop, {
      input: "",
      env: { ...process.env, PLUGIN_ROOT: pluginDir, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX },
      encoding: "utf-8",
    });
    expect(stdout).toBe("");
  });
});
