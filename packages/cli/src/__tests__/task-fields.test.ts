/**
 * Task fields + task log against a remote (Community) nest:
 * `ctx update --assignee/--due/--priority/--parent`,
 * `ctx list --assignee/--priority/--due-before`, `ctx task log`.
 *
 * The nest validates (roster, date, priority, parent); these lock what the CLI
 * sends, that "" / none clears, and that an older server that silently drops
 * the arguments is reported instead of read as success.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextNestError } from "@promptowl/contextnest-engine";
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";

let advertised = new Set<string>();
let replies: Record<string, unknown> = {};
let calls: Array<{ op: string; input: Record<string, unknown> }> = [];

vi.mock("@promptowl/contextnest-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptowl/contextnest-engine")>();
  return {
    ...actual,
    connectRemoteNest: async () => ({
      toolNames: async () => advertised as ReadonlySet<string>,
      run: async (op: string, input: Record<string, unknown>) => {
        calls.push({ op, input });
        return replies[op];
      },
      close: async () => {},
    }),
  };
});

const { remoteUpdate, remoteList, remoteTaskLog } = await import("../remote.js");
const { configureSafety } = await import("../safety.js");
const { taskFieldArgs, taskListFilters, parseIsoDate, parseTaskLogStatus } = await import("../task-fields.js");

const target = { alias: "team", spec: { transport: "stdio", command: "node" } as RemoteNestSpec };

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
const plain = () => out.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

beforeEach(() => {
  advertised = new Set(["context_update", "context_list", "context_task_log"]);
  replies = {};
  calls = [];
  out = [];
  configureSafety({});
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.join(" "));
  });
});
afterEach(() => {
  logSpy.mockRestore();
  delete process.env.CONTEXTNEST_AGENT;
});

describe("task field flags", () => {
  it('maps "" and none to null (clear) and leaves absent flags out', () => {
    expect(taskFieldArgs({ assignee: "a@b.co", due: "", priority: "none" })).toEqual({
      assignee: "a@b.co",
      due: null,
      priority: null,
    });
    expect(taskFieldArgs({})).toEqual({});
  });

  it('list filters: "" means none, as it does for update', () => {
    expect(taskListFilters({ assignee: "", priority: " high " })).toEqual({ assignee: "none", priority: "high" });
    expect(taskListFilters({ assignee: "None", priority: "NONE" })).toEqual({ assignee: "none", priority: "none" });
    expect(taskListFilters({})).toEqual({});
  });

  it("--due-before takes YYYY-MM-DD only", () => {
    expect(parseIsoDate(" 2026-10-31 ")).toBe("2026-10-31");
    expect(() => parseIsoDate("10/31/2026")).toThrow(/YYYY-MM-DD/);
  });

  it("--status accepts working | done | blocked only, any case", () => {
    expect(parseTaskLogStatus("done")).toBe("done");
    expect(parseTaskLogStatus("Done")).toBe("done");
    expect(() => parseTaskLogStatus("finished")).toThrow(/working, done, blocked/);
  });
});

describe("ctx update on a remote nest", () => {
  it("sends task fields to context_update and prints what the nest set", async () => {
    replies.context_update = { id: "nodes/t", version: 3, status: "published", assignee: "a@b.co", priority: "high", parent: "nodes/epic" };
    await remoteUpdate(target, "nodes/t", { assignee: "a@b.co", priority: "high", due: "none", parent: "nodes/epic" });
    expect(calls).toEqual([
      { op: "context_update", input: { id: "nodes/t", assignee: "a@b.co", priority: "high", due: null, parent: "nodes/epic" } },
    ]);
    expect(plain()).toContain("Assignee: a@b.co");
    expect(plain()).toContain("Parent: nodes/epic");
    expect(plain()).toContain("Due: (cleared)");
  });

  it("a task field alone is enough to update", async () => {
    replies.context_update = { id: "nodes/t", version: 4, due: "2026-10-31" };
    await expect(remoteUpdate(target, "nodes/t", { due: "2026-10-31" })).resolves.toBeUndefined();
  });

  it("a set field the nest did not return is not reported as cleared", async () => {
    replies.context_update = { id: "nodes/t", version: 4 };
    await remoteUpdate(target, "nodes/t", { priority: "high" });
    expect(plain()).toContain("Priority: (not returned by the nest)");
    expect(plain()).not.toContain("(cleared)");
  });

  it("an older server is refused before anything is written — set or clear", async () => {
    advertised = new Set(["context_update", "context_list"]);
    replies.context_update = { id: "nodes/t", version: 5, status: "published" };
    for (const opts of [{ assignee: "a@b.co", body: "x" }, { due: "none" }]) {
      const err = await remoteUpdate(target, "nodes/t", opts).catch((e) => e);
      expect(err).toBeInstanceOf(ContextNestError);
      expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    }
    expect(calls).toEqual([]);
    expect(plain()).not.toContain("Updated");
    expect(plain()).not.toContain("(cleared)");
  });

  it("an older server still takes updates without task fields", async () => {
    advertised = new Set(["context_update"]);
    replies.context_update = { id: "nodes/t", version: 6 };
    await remoteUpdate(target, "nodes/t", { body: "x" });
    expect(calls).toHaveLength(1);
  });
});

describe("ctx list filters on a remote nest", () => {
  it("passes assignee / priority / due_before to context_list and shows the fields", async () => {
    replies.context_list = {
      documents: [{ id: "nodes/t", title: "T", type: "task", status: "published", assignee: "a@b.co", due: "2026-10-01", priority: "high" }],
    };
    await remoteList(target, { assignee: "a@b.co", priority: "high", dueBefore: "2026-10-31" });
    expect(calls[0]).toEqual({
      op: "context_list",
      input: { assignee: "a@b.co", priority: "high", due_before: "2026-10-31" },
    });
    expect(plain()).toContain("assignee a@b.co · due 2026-10-01 · priority high");
  });

  it("--json carries the task fields", async () => {
    replies.context_list = { documents: [{ id: "nodes/t", title: "T", type: "task", status: "published", assignee: "a@b.co" }] };
    await remoteList(target, { json: true });
    expect(JSON.parse(plain())[0]).toMatchObject({ id: "nodes/t", assignee: "a@b.co" });
  });

  it("an older server is refused before listing, even if the result would be empty", async () => {
    advertised = new Set(["context_list"]);
    replies.context_list = { documents: [] };
    const err = await remoteList(target, { assignee: "a@b.co" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect(calls).toEqual([]);
    // No task filter → no capability needed.
    await remoteList(target, {});
    expect(calls).toHaveLength(1);
  });
});

describe("ctx task log", () => {
  const entry = {
    id: "e1",
    actor: "misha@x.com",
    status: "working",
    note: "on it",
    key: { label: "laptop", prefix: "cnst_abc", scoped: true },
    client: { agent: "Claude Code" },
    at: "2026-10-11T00:00:00Z",
  };

  it("calls context_task_log with note, status, claim and the agent", async () => {
    process.env.CONTEXTNEST_AGENT = "Claude Code";
    replies.context_task_log = { id: "nodes/t", entry, claim: "assigned", assignee: "misha@x.com" };
    await remoteTaskLog(target, "nodes/t", { note: "on it", status: "working", claim: true });
    expect(calls).toEqual([
      {
        op: "context_task_log",
        input: { id: "nodes/t", note: "on it", status: "working", claim: true, client: { agent: "Claude Code" } },
      },
    ]);
    const text = plain();
    expect(text).toContain("Claude Code (key laptop) on behalf of misha@x.com · working");
    expect(text).toContain("Assigned to you");
  });

  it("--json prints the server reply as-is", async () => {
    replies.context_task_log = { id: "nodes/t", entry };
    await remoteTaskLog(target, "nodes/t", { note: "on it", json: true });
    expect(JSON.parse(plain())).toEqual({ id: "nodes/t", entry });
  });

  it("reports a claim on a task someone else holds, and ignores a blank agent", async () => {
    process.env.CONTEXTNEST_AGENT = "   ";
    replies.context_task_log = { id: "nodes/t", entry, claim: "assigned_to_other", assignee: "ann@x.com" };
    await remoteTaskLog(target, "nodes/t", { note: "on it", claim: true });
    expect(calls[0].input).not.toHaveProperty("client");
    expect(plain()).toContain("Not claimed — already assigned to ann@x.com");
  });

  it("--agent overrides $CONTEXTNEST_AGENT", async () => {
    process.env.CONTEXTNEST_AGENT = "Claude Code";
    replies.context_task_log = { id: "nodes/t", entry };
    await remoteTaskLog(target, "nodes/t", { note: "on it", agent: " Codex " });
    expect(calls[0].input.client).toEqual({ agent: "Codex" });
  });

  it("already_yours prints no claim line", async () => {
    replies.context_task_log = { id: "nodes/t", entry, claim: "already_yours", assignee: "misha@x.com" };
    await remoteTaskLog(target, "nodes/t", { note: "on it", claim: true });
    expect(plain()).not.toMatch(/Assigned to you|Not claimed/);
  });

  it("goes through the remote write guard (--dry-run refuses)", async () => {
    configureSafety({ dryRun: true });
    const err = await remoteTaskLog(target, "nodes/t", { note: "x" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect(calls).toEqual([]);
  });

  it("says when the server has no task log", async () => {
    advertised = new Set(["context_update"]);
    const err = await remoteTaskLog(target, "nodes/t", { note: "x" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect(calls).toEqual([]);
  });
});

// The local-vault refusals live in index.ts, so drive the built CLI.
describe("local vaults refuse task flags", () => {
  const distPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
  const tmp = mkdtempSync(join(tmpdir(), "cn-task-local-"));
  mkdirSync(join(tmp, ".context"));
  writeFileSync(join(tmp, ".context", "config.yaml"), "version: 1\nname: local\n");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const ctx = (...args: string[]) =>
    spawnSync("node", [distPath, ...args], {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, CONTEXTNEST_CONFIG_DIR: tmp, CONTEXTNEST_VAULT: "", CONTEXTNEST_VAULT_PATH: tmp },
    });

  it.each([
    ["update", "nodes/t", "--assignee", "a@b.co"],
    ["update", "nodes/t", "--due", ""],
    ["list", "--assignee", ""],
    ["list", "--priority", "high"],
    ["task", "log", "nodes/t", "--note", "x"],
  ])("ctx %s %s …", (...args) => {
    const r = ctx(...args);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Community nest/);
  });
});
