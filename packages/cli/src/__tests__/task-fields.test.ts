/**
 * Task fields + task log against a remote (Community) nest:
 * `ctx update --assignee/--due/--priority/--parent`,
 * `ctx list --assignee/--priority/--due-before`, `ctx task log`.
 *
 * The nest validates (roster, date, priority, parent); these lock what the CLI
 * sends, that "" / none clears, and that an older server that silently drops
 * the arguments is reported instead of read as success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const {
  taskFieldArgs,
  unappliedTaskFields,
  parseTaskLogStatus,
  taskFiltersIgnored,
} = await import("../task-fields.js");

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

  it("flags a field that was set but not echoed back", () => {
    expect(unappliedTaskFields({ assignee: "a@b.co", due: null }, {})).toEqual(["assignee"]);
    expect(unappliedTaskFields({ assignee: "a@b.co" }, { assignee: "a@b.co" })).toEqual([]);
  });

  it("--status accepts working | done | blocked only", () => {
    expect(parseTaskLogStatus("done")).toBe("done");
    expect(() => parseTaskLogStatus("finished")).toThrow(/working, done, blocked/);
  });
});

describe("ctx update on a remote nest", () => {
  it("sends task fields to context_update and prints what the nest set", async () => {
    replies.context_update = { id: "nodes/t", version: 3, status: "published", assignee: "a@b.co", priority: "high" };
    await remoteUpdate(target, "nodes/t", { assignee: "a@b.co", priority: "high", due: "none" });
    expect(calls).toEqual([
      { op: "context_update", input: { id: "nodes/t", assignee: "a@b.co", priority: "high", due: null } },
    ]);
    expect(plain()).toContain("Assignee: a@b.co");
    expect(plain()).toContain("Due: (cleared)");
  });

  it("a task field alone is enough to update", async () => {
    replies.context_update = { id: "nodes/t", version: 4, due: "2026-10-31" };
    await expect(remoteUpdate(target, "nodes/t", { due: "2026-10-31" })).resolves.toBeUndefined();
  });

  it("refuses to report success when an older server dropped the fields", async () => {
    replies.context_update = { id: "nodes/t", version: 5, status: "published" };
    const err = await remoteUpdate(target, "nodes/t", { assignee: "a@b.co" }).catch((e) => e);
    expect(err).toBeInstanceOf(ContextNestError);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect((err as Error).message).toContain("--assignee");
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

  it("an older server that ignored the filters is reported, not listed", async () => {
    expect(taskFiltersIgnored({ assignee: "none" }, [{ assignee: "x@y.z" }])).toBe(true);
    replies.context_list = { documents: [{ id: "nodes/other", title: "O", type: "task", status: "published" }] };
    const err = await remoteList(target, { assignee: "a@b.co" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
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

  it("says when the server has no task log", async () => {
    advertised = new Set(["context_update"]);
    const err = await remoteTaskLog(target, "nodes/t", { note: "x" }).catch((e) => e);
    expect((err as ContextNestError).code).toBe("NOT_IMPLEMENTED");
    expect(calls).toEqual([]);
  });
});
