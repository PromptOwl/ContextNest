/**
 * OpenCode adapter (plugins/opencode): hooks are called in the order OpenCode
 * calls them, with a fake ctx and an in-memory ledger, so each test asserts
 * what reaches the model. The OpenCode 2 message shapes are the ones a live
 * OpenCode 2.0.32 run produced.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hooksV1, promptText, readMessages, readSkills, setupV2, SKILLS_DIR } from "../opencode/adapter.js";
import plugin from "../opencode/index.js";
import { MAX_LIST_SCAN } from "../shared/core/lib.js";

// getConfig() reads settings files from the project dir and home dir; keep a
// developer's own pinned vault out of these assertions (see core.unit.test.ts).
let SANDBOX: string;
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "cn-opencode-"));
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

type Opts = { env?: Record<string, string>; calls?: string[]; timeouts?: unknown[] };
function deps(routes: [string, unknown][] = [], opts: Opts = {}) {
  const exec = fakeExec(routes, opts.calls);
  return {
    env: { CLAUDE_PROJECT_DIR: SANDBOX, ...(opts.env ?? {}) },
    newExec: (timeout?: number) => {
      opts.timeouts?.push(timeout);
      return exec;
    },
    ledgerIo: fakeLedgerIo(),
  };
}

/** A fake OpenCode 2 plugin context that records what the plugin registers. */
async function v2(routes: [string, unknown][] = [], opts: Opts = {}) {
  const hooks: Record<string, (e: any) => unknown> = {};
  const skills: any[] = [];
  const ctx = {
    skill: { transform: async (fn: (editor: any) => void) => fn({ add: (s: any) => skills.push(s) }) },
    session: { hook: async (name: string, fn: (e: any) => unknown) => void (hooks[name] = fn) },
  };
  await setupV2(ctx, deps(routes, opts));
  const prompt = (sessionID: string, text: string) => hooks.prompt({ sessionID, prompt: { text, files: [] } });
  const context = async (sessionID: string, messages: any[] = []) => {
    const e = { sessionID, system: [{ type: "text", text: "base" }], messages };
    await hooks.context(e);
    return e.system.slice(1).map((p) => p.text).join("\n\n");
  };
  return { hooks, skills, prompt, context };
}

// OpenCode 2.0.32 message shapes.
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const shellCall = (id: string, command: string) => ({
  role: "assistant",
  content: [{ type: "tool-call", id, name: "shell", input: { command } }],
});
const result = (id: string) => ({ role: "tool", content: [{ type: "tool-result", id, name: "shell", result: { type: "text", value: "" } }] });

const SEARCH_HIT: [string, unknown] = ["search", [{ id: "nodes/auth", title: "Auth design", type: "document" }]];
const SWEEP: [string, unknown][] = [
  ["vault list", [{ alias: "eng", exists: true }]],
  ["read nodes/a --raw --vault eng", "---\nt: x\n---\nSessions live in Postgres."],
  ["history nodes/a --json --vault eng", { versions: [{ version: 1 }, { version: 2 }] }],
  ["reconstruct nodes/a 1 --vault eng", "---\nt: x\n---\nSessions live in Redis."],
  [`search redis --json --limit ${MAX_LIST_SCAN} --vault eng`, [{ id: "nodes/pitch" }]],
  ["read nodes/pitch --raw --vault eng", "---\nt: x\n---\nWe brag about Redis speed."],
];
const UPDATE = "ctx --vault eng update nodes/a --body-file -";

describe("opencode 2 (setup)", () => {
  it("registers the four skills with their frontmatter", async () => {
    const { skills } = await v2();
    expect(skills.map((s) => s.id).sort()).toEqual([
      "contextnest-capture",
      "contextnest-curate",
      "contextnest-recall",
      "contextnest-structure",
    ]);
    const recall = skills.find((s) => s.id === "contextnest-recall");
    expect(recall.description).toMatch(/^Retrieve ContextNest vault knowledge/);
    expect(recall.content).not.toMatch(/^---/);
  });

  it("context: overview and rules once per session, plus this turn's retrieval", async () => {
    const calls: string[] = [];
    const t = await v2([["vault list", [{ alias: "eng", exists: true }]], SEARCH_HIT], { calls });
    await t.prompt("s1", "how does auth work?");
    const first = await t.context("s1", [user("how does auth work?")]);
    expect(first).toContain("Context Nest is active");
    expect(first).toContain("`contextnest-curator` agent → `contextnest-curate` skill");
    expect(first).not.toContain("<!--");
    expect(first).toContain("nodes/auth");

    const probes = calls.filter((c) => c === "vault list --json").length;
    expect(await t.context("s1", [user("how does auth work?")])).toContain("nodes/auth");
    expect(calls.filter((c) => c === "vault list --json").length).toBe(probes);
  });

  it("context: a finished `ctx update` shell call adds the sweep report, once per call", async () => {
    const timeouts: unknown[] = [];
    const calls: string[] = [];
    const t = await v2(SWEEP, { timeouts, calls });
    await t.prompt("s2", "fix it");
    // Still running (no result yet): nothing to sweep.
    expect(await t.context("s2", [user("fix it"), shellCall("c1", UPDATE)])).not.toContain("still contains");

    const done = [user("fix it"), shellCall("c1", UPDATE), result("c1")];
    expect(await t.context("s2", done)).toContain('eng:nodes/pitch still contains "redis"');
    expect(timeouts.some((x) => typeof x === "number" && x > 8000)).toBe(true);

    const reads = calls.length;
    expect(await t.context("s2", done)).toContain("still contains");
    expect(calls.length).toBe(reads); // swept once, then only re-shown

    await t.prompt("s2", "next");
    expect(await t.context("s2", [...done, user("next")])).not.toContain("still contains");
  });

  it("prompt: an explicit capture in the last turn is handed over with the next prompt, once", async () => {
    const t = await v2();
    await t.prompt("s3", "remember this: we deploy on Fridays");
    await t.context("s3", [user("remember this: we deploy on Fridays")]);

    await t.prompt("s3", "thanks");
    expect(await t.context("s3")).toMatch(/capture pass was queued/);

    await t.prompt("s3", "ok");
    expect(await t.context("s3")).not.toMatch(/capture pass was queued/);
  });

  it("prompt: a correction queues a sweep; capture_mode=off queues nothing", async () => {
    const t = await v2();
    await t.prompt("s4", "actually we deploy on Mondays");
    await t.context("s4", [user("actually we deploy on Mondays")]);
    await t.prompt("s4", "ok");
    expect(await t.context("s4")).toMatch(/correction sweep was queued/);

    const off = await v2([], { env: { CONTEXTNEST_CAPTURE_MODE: "off" } });
    await off.prompt("s5", "remember this: x");
    await off.context("s5", [user("remember this: x")]);
    await off.prompt("s5", "ok");
    expect(await off.context("s5")).not.toMatch(/queued/);
  });

  it("readMessages: counts user turns, maps tool calls, keeps only finished shell calls", () => {
    const r = readMessages([user("a"), shellCall("c1", "ls"), result("c1"), shellCall("c2", "pwd"), user("b"), { role: "x" }]);
    expect(r.userTurns).toBe(2);
    expect(r.lines.filter((l: any) => l.message.content?.[0]?.type === "tool_use")).toHaveLength(2);
    expect(r.shellCalls).toEqual([{ id: "c1", command: "ls" }]);
    expect(readMessages(undefined)).toEqual({ lines: [], userTurns: 0, shellCalls: [] });
  });

  it("compaction gets the rules too", async () => {
    const t = await v2();
    const e = { sessionID: "s6", system: [] as any[] };
    await t.hooks.compaction(e);
    expect(e.system.map((p) => p.text).join("\n")).toContain("ContextNest Operating Rules");
  });
});

describe("opencode 1 (server)", () => {
  const say = (text: string) => ({ message: {}, parts: [{ type: "text", text }] });
  async function system(h: any, sessionID: string) {
    const output = { system: [] as string[] };
    await h["experimental.chat.system.transform"]({ sessionID }, output);
    return output.system.join("\n\n");
  }

  it("chat.message retrieves what the user typed; the system transform carries it", async () => {
    const calls: string[] = [];
    const h = hooksV1(deps([SEARCH_HIT], { calls }));
    const parts = [
      { type: "text", text: "auth flow" },
      { type: "text", text: "injected by another plugin", synthetic: true },
    ];
    await h["chat.message"]({ sessionID: "v1" }, { message: {}, parts });
    expect(calls.some((c) => c.startsWith("search auth flow --json"))).toBe(true);
    expect(calls.some((c) => c.includes("injected"))).toBe(false);
    expect(await system(h, "v1")).toContain("nodes/auth");
    expect(promptText(undefined)).toBe("");
  });

  it("tool.execute.after on bash sweeps once per call; the next model call gets the report", async () => {
    const h = hooksV1(deps(SWEEP));
    await h["chat.message"]({ sessionID: "v2" }, say("fix it"));
    const input = { tool: "bash", sessionID: "v2", callID: "c1", args: { command: UPDATE } };
    await h["tool.execute.after"](input, { title: "", output: "", metadata: {} });
    expect(await system(h, "v2")).toContain('eng:nodes/pitch still contains "redis"');
  });

  it("an explicit capture is handed over with the next prompt", async () => {
    const h = hooksV1(deps());
    await h["chat.message"]({ sessionID: "v3" }, say("remember this: we deploy on Fridays"));
    await h["chat.message"]({ sessionID: "v3" }, say("thanks"));
    expect(await system(h, "v3")).toMatch(/capture pass was queued/);
  });

  it("config registers the skills folder once", async () => {
    const h = hooksV1(deps());
    const config: any = {};
    await h.config(config);
    await h.config(config);
    expect(config.skills.paths).toEqual([SKILLS_DIR]);
  });
});

describe("index.js", () => {
  it("one default export serves both APIs", async () => {
    expect(plugin.id).toBe("contextnest");
    expect(typeof plugin.setup).toBe("function");
    const h = await plugin.server({ directory: SANDBOX } as any);
    for (const name of ["config", "chat.message", "experimental.chat.system.transform", "tool.execute.after"]) {
      expect(typeof (h as any)[name]).toBe("function");
    }
    expect(readSkills(join(SANDBOX, "nope"))).toEqual([]);
  });
});
