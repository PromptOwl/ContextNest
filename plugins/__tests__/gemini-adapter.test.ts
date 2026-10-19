/**
 * Antigravity adapter (plugins/gemini/hooks/antigravity.js): the pure run() is
 * called with a fake exec and in-memory ledger, so each test asserts what
 * actually reaches the model — not just that the hook exited 0.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run, lastRecord, readTranscript } from "../gemini/hooks/antigravity.js";
import { MAX_LIST_SCAN } from "../shared/core/lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "gemini");

// getConfig() reads settings files from the project dir and home dir; keep a
// developer's own pinned vault out of these assertions (see core.unit.test.ts).
let SANDBOX: string;
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "cn-agy-"));
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

/** Write an Antigravity-style transcript (CRLF, to prove line endings don't matter). */
function transcript(records: object[]): string {
  const path = join(mkdtempSync(join(SANDBOX, "tx-")), "transcript.jsonl");
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\r\n") + "\r\n");
  return path;
}
const user = (content: string) => ({ type: "USER_INPUT", content });
const step = { type: "PLANNER_RESPONSE", content: "thinking" };
const systemText = (out: any): string => out?.injectSteps?.[0]?.systemMessage ?? "";

describe("antigravity adapter", () => {
  it("PreInvocation: searches the vault for a fresh user prompt", () => {
    const calls: string[] = [];
    const exec = fakeExec([["search", [{ id: "nodes/auth", title: "Auth design", type: "document" }]]], calls);
    const out = run("PreInvocation", {
      input: { conversationId: "c1", transcriptPath: transcript([user("how does auth work?")]) },
      env: env(),
      exec,
      ledgerIo: fakeLedgerIo(),
    });
    expect(calls.some((c) => c.startsWith("search how does auth work?"))).toBe(true);
    expect(systemText(out)).toContain("nodes/auth");
  });

  it("PreInvocation: later model calls in the same turn do not search again", () => {
    const calls: string[] = [];
    const out = run("PreInvocation", {
      input: { conversationId: "c1", transcriptPath: transcript([user("how does auth work?"), step]) },
      env: { ...env(), CONTEXTNEST_RETRIEVAL_MODE: "agent" },
      exec: fakeExec([], calls),
      ledgerIo: fakeLedgerIo(),
    });
    expect(calls).toEqual([]);
    expect(out).toEqual({});
  });

  it("PostToolUse: answers {} and hands the sweep report to the next model call, once", () => {
    const ledgerIo = fakeLedgerIo();
    const exec = fakeExec([
      ["vault list", [{ alias: "eng", exists: true }]],
      ["read nodes/a --raw --vault eng", "---\nt: x\n---\nSessions live in Postgres."],
      ["history nodes/a --json --vault eng", { versions: [{ version: 1 }, { version: 2 }] }],
      ["reconstruct nodes/a 1 --vault eng", "---\nt: x\n---\nSessions live in Redis."],
      [`search redis --json --limit ${MAX_LIST_SCAN} --vault eng`, [{ id: "nodes/pitch" }]],
      ["read nodes/pitch --raw --vault eng", "---\nt: x\n---\nWe brag about Redis speed."],
    ]);
    const toolCall = { name: "run_command", args: { CommandLine: "ctx --vault eng update nodes/a --body x" } };
    expect(run("PostToolUse", { input: { conversationId: "c2", toolCall }, env: env(), exec, ledgerIo })).toEqual({});

    const next = { conversationId: "c2", transcriptPath: transcript([user("fix the doc"), step]) };
    const delivered = run("PreInvocation", { input: next, env: env(), exec: fakeExec([]), ledgerIo });
    expect(systemText(delivered)).toContain('eng:nodes/pitch still contains "redis"');
    expect(run("PreInvocation", { input: next, env: env(), exec: fakeExec([]), ledgerIo })).toEqual({});
  });

  it("PostToolUse: ignores commands that are not vault updates", () => {
    const calls: string[] = [];
    const toolCall = { name: "run_command", args: { CommandLine: "echo 'ctx update nodes/a'" } };
    run("PostToolUse", { input: { conversationId: "c3", toolCall }, env: env(), exec: fakeExec([], calls) });
    expect(calls).toEqual([]);
  });

  it("Stop: parks an explicit capture and the next prompt receives it", () => {
    const ledgerIo = fakeLedgerIo();
    const path = transcript([user("remember this: we deploy on Fridays"), step]);
    const out = run("Stop", { input: { conversationId: "c4", transcriptPath: path }, env: env(), exec: fakeExec([]), ledgerIo });
    expect(out).toEqual({ decision: "stop" });

    const next = transcript([user("remember this: we deploy on Fridays"), step, user("thanks")]);
    const delivered = run("PreInvocation", {
      input: { conversationId: "c4", transcriptPath: next },
      env: env(),
      exec: fakeExec([]),
      ledgerIo,
    });
    expect(systemText(delivered)).toMatch(/capture pass was queued/);
  });

  it("Stop: a capture job joins a sweep report parked on the last step instead of replacing it", () => {
    const ledgerIo = fakeLedgerIo();
    const exec = fakeExec([
      ["vault list", [{ alias: "eng", exists: true }]],
      ["read nodes/a --raw --vault eng", "---\nt: x\n---\nSessions live in Postgres."],
      ["history nodes/a --json --vault eng", { versions: [{ version: 1 }, { version: 2 }] }],
      ["reconstruct nodes/a 1 --vault eng", "---\nt: x\n---\nSessions live in Redis."],
      [`search redis --json --limit ${MAX_LIST_SCAN} --vault eng`, [{ id: "nodes/pitch" }]],
      ["read nodes/pitch --raw --vault eng", "---\nt: x\n---\nWe brag about Redis speed."],
    ]);
    const toolCall = { name: "run_command", args: { CommandLine: "ctx --vault eng update nodes/a --body x" } };
    run("PostToolUse", { input: { conversationId: "c5", toolCall }, env: env(), exec, ledgerIo });
    const path = transcript([user("remember this: sessions moved to Postgres"), step]);
    run("Stop", { input: { conversationId: "c5", transcriptPath: path }, env: env(), exec: fakeExec([]), ledgerIo });

    const next = transcript([user("remember this: sessions moved to Postgres"), step, user("ok")]);
    const text = systemText(
      run("PreInvocation", { input: { conversationId: "c5", transcriptPath: next }, env: env(), exec: fakeExec([]), ledgerIo }),
    );
    expect(text).toContain('eng:nodes/pitch still contains "redis"');
    expect(text).toMatch(/capture pass was queued/);
  });

  it("structured content: only text parts reach search; no text means no search", () => {
    const calls: string[] = [];
    const parts = { type: "USER_INPUT", content: [{ text: "auth flow" }, { image: "x.png" }] };
    run("PreInvocation", {
      input: { conversationId: "c6", transcriptPath: transcript([parts]) },
      env: env(),
      exec: fakeExec([], calls),
      ledgerIo: fakeLedgerIo(),
    });
    expect(calls.some((c) => c.startsWith("search auth flow --json"))).toBe(true);

    const imageOnly = { type: "USER_INPUT", content: [{ image: "x.png" }] };
    const none: string[] = [];
    run("PreInvocation", {
      input: { conversationId: "c6", transcriptPath: transcript([imageOnly]) },
      env: env(),
      exec: fakeExec([], none),
      ledgerIo: fakeLedgerIo(),
    });
    expect(none).toEqual([]);
  });

  it("PreInvocation: a missing or garbage transcript injects nothing", () => {
    const garbage = join(mkdtempSync(join(SANDBOX, "tx-")), "transcript.jsonl");
    writeFileSync(garbage, "not json\n{broken");
    for (const transcriptPath of [undefined, join(SANDBOX, "nope.jsonl"), garbage]) {
      const out = run("PreInvocation", {
        input: { conversationId: "c7", transcriptPath },
        env: env(),
        exec: fakeExec([]),
        ledgerIo: fakeLedgerIo(),
      });
      expect(out).toEqual({});
    }
  });

  it("readTranscript counts Antigravity user records as turns; lastRecord reads the tail", () => {
    const path = transcript([user("a"), step, user("b"), step]);
    expect(readTranscript(path).userTurns).toBe(2);
    expect(lastRecord(path)).toEqual(step);
    expect(lastRecord(undefined)).toBeNull();
  });

  it("Stop shell answers with the required decision on empty or malformed stdin", () => {
    for (const input of ["", "{not json"]) {
      const stdout = execFileSync("node", [join(pluginDir, "hooks", "antigravity.js"), "Stop"], {
        input,
        env: { ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX },
        encoding: "utf-8",
      });
      expect(JSON.parse(stdout), input).toEqual({ decision: "stop" });
    }
  });

  it("hooks.json: every command runs the adapter with a handled event, no shell-only syntax", () => {
    const hooks = JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf-8"));
    const commands = Object.values(hooks).flatMap((def: any) =>
      Object.values(def).flatMap((entries: any) => entries.flatMap((e: any) => (e.hooks ?? [e]).map((h: any) => h.command))),
    );
    expect(commands).toHaveLength(4);
    for (const cmd of commands) {
      expect(cmd).toMatch(/^node \.\/hooks\/antigravity\.js (SessionStart|PreInvocation|PostToolUse|Stop)$/);
    }
    expect(existsSync(join(pluginDir, "hooks", "antigravity.js"))).toBe(true);
  });
});
