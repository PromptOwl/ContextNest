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

/** `ctx list` filter flags → context_list arguments (`none` passes through). */
export function taskListFilters(opts: {
  assignee?: string;
  priority?: string;
  dueBefore?: string;
}): TaskListFilters {
  return {
    ...(opts.assignee ? { assignee: opts.assignee } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.dueBefore ? { due_before: opts.dueBefore } : {}),
  };
}

/**
 * A server that predates task fields silently drops the arguments (the MCP SDK
 * strips undeclared keys) and reports success. It also echoes nothing back, so
 * a field that was SET but is missing from the reply was not applied.
 */
export function unappliedTaskFields(
  sent: TaskFieldArgs,
  echoed: Partial<Record<string, unknown>>,
): TaskFieldFlag[] {
  return TASK_FIELD_FLAGS.filter((k) => typeof sent[k] === "string" && echoed[k] === undefined);
}

export const TASK_LOG_STATUSES = ["working", "done", "blocked"] as const;

/** Commander option parser for `ctx task log --status`. */
export function parseTaskLogStatus(v: string): string {
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

/**
 * True when a listing could NOT have come from a server that applied the task
 * filters — an older server strips them and lists everything. Checked on the
 * rows themselves, since the reply carries no other signal.
 */
export function taskFiltersIgnored(
  filters: TaskListFilters,
  docs: Array<{ assignee?: string; priority?: string; due?: string }>,
): boolean {
  return docs.some((d) => {
    if (filters.assignee !== undefined) {
      const want = filters.assignee.toLowerCase();
      if (want === "none" ? !!d.assignee : d.assignee?.toLowerCase() !== want) return true;
    }
    if (filters.priority !== undefined) {
      if (filters.priority === "none" ? !!d.priority : d.priority !== filters.priority) return true;
    }
    if (filters.due_before !== undefined) {
      if (!d.due || d.due > filters.due_before) return true;
    }
    return false;
  });
}
