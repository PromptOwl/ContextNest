/**
 * Task (board) fields for the remote commands — `ctx update --assignee/--due/
 * --priority/--parent`, `ctx list --assignee/--priority/--due-before` and
 * `ctx task log`.
 *
 * Task fields belong to a Community nest: an assignee has to be on that nest's
 * roster, which only the server knows. So the server validates (roster, date,
 * priority set, parent, cycles) and the CLI only translates flags into tool
 * arguments. The one rule applied here is "an empty value or `none` clears the
 * field", because a shell can't send JSON null.
 */
import { InvalidArgumentError } from "commander";
import { ContextNestError } from "@promptowl/contextnest-engine";

export const TASK_FIELD_FLAGS = ["assignee", "due", "priority", "parent"] as const;
export type TaskFieldFlag = (typeof TASK_FIELD_FLAGS)[number];

export type TaskFieldArgs = Partial<Record<TaskFieldFlag, string | null>>;

/** `--assignee ""` / `--assignee none` → null (clear); absent → left alone. */
export function taskFieldArgs(opts: Partial<Record<TaskFieldFlag, unknown>>): TaskFieldArgs {
  const out: TaskFieldArgs = {};
  for (const k of TASK_FIELD_FLAGS) {
    const v = opts[k];
    if (v === undefined) continue;
    const s = String(v).trim();
    out[k] = s === "" || s.toLowerCase() === "none" ? null : s;
  }
  return out;
}

export function hasTaskFieldArgs(a: TaskFieldArgs): boolean {
  return Object.keys(a).length > 0;
}

export interface TaskListFilters {
  assignee?: string;
  priority?: string;
  due_before?: string;
}

/**
 * `ctx list` filter flags → context_list arguments. `""` means `none`, as it
 * does for `ctx update`, so an empty value filters for unset rather than
 * falling through to an unfiltered listing.
 */
export function taskListFilters(opts: {
  assignee?: string;
  priority?: string;
  dueBefore?: string;
}): TaskListFilters {
  const orNone = (v: string) => {
    const s = v.trim();
    return s === "" || s.toLowerCase() === "none" ? "none" : s;
  };
  return {
    ...(opts.assignee !== undefined ? { assignee: orNone(opts.assignee) } : {}),
    ...(opts.priority !== undefined ? { priority: orNone(opts.priority) } : {}),
    ...(opts.dueBefore !== undefined ? { due_before: opts.dueBefore } : {}),
  };
}

/**
 * A server that predates task fields strips the arguments (the MCP SDK drops
 * undeclared keys) and still reports success. Task fields, the list filters and
 * `context_task_log` shipped in the same server release, so the advertised tool
 * is the capability signal. Checked BEFORE the call: nothing half-applies, and
 * a clear (which the server never echoes back) cannot be reported as done.
 */
export async function requireTaskSupport(
  conn: { toolNames(): Promise<ReadonlySet<string>> },
  alias: string,
): Promise<void> {
  if (!(await conn.toolNames()).has("context_task_log")) {
    throw new ContextNestError(
      `"${alias}" does not support task fields or the task log — its server predates them. Upgrade the Community server. Nothing was written.`,
      "NOT_IMPLEMENTED",
    );
  }
}

/** Commander option parser for `ctx list --due-before`: the nest compares dates as YYYY-MM-DD. */
export function parseIsoDate(v: string): string {
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new InvalidArgumentError("expected a date as YYYY-MM-DD.");
  return s;
}

export const TASK_LOG_STATUSES = ["working", "done", "blocked"] as const;

/** Commander option parser for `ctx task log --status`. */
export function parseTaskLogStatus(v: string): string {
  v = v.trim().toLowerCase();
  if (!(TASK_LOG_STATUSES as readonly string[]).includes(v)) {
    throw new InvalidArgumentError(`--status must be one of ${TASK_LOG_STATUSES.join(", ")}.`);
  }
  return v;
}

export function localTaskFieldsError(what: string): ContextNestError {
  return new ContextNestError(
    `${what} work on a Community nest (an assignee must be on its roster) — point --vault at a remote nest.`,
    "NOT_IMPLEMENTED",
  );
}

/** " · assignee x · due 2026-10-31 · priority high" for a listing row; "" when unset. */
export function taskFieldsSuffix(d: {
  assignee?: string;
  due?: string;
  priority?: string;
  parent?: string;
}): string {
  const parts = [
    d.assignee ? `assignee ${d.assignee}` : null,
    d.due ? `due ${d.due}` : null,
    d.priority ? `priority ${d.priority}` : null,
    d.parent ? `parent ${d.parent}` : null,
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}
