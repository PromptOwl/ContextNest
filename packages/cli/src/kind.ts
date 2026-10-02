/**
 * `ctx kind apply` — turn a pulled kind into requests against a hosted nest.
 *
 * A pull lands a recipe's `kind:` section as a document (`nodes/kinds/<id>`,
 * see pull.ts). This module reads that section and maps each entry onto the
 * Community server's REST API:
 *
 *   edge_types → POST /nests/:id/edge-types      (upsert by name)
 *   edges      → POST /nests/:id/edges           (409 = already there)
 *   schedules  → POST /nests/:id/schedules       (one per agent)
 *   plugins    → PUT  /nests/:id/plugins/:name   (configured, never enabled)
 *   stewards   → POST /nests/:id/stewards        (placeholders mapped by hand)
 *
 * The first three sit behind the server's FEATURE_WORKFLOW_PLANE flag and
 * plugins behind FEATURE_PLUGINS; both answer 404 when off. Planning probes
 * them with GETs, so a dry run already says what would be skipped and why.
 * Planning sends nothing else, and execution sends only what the plan holds.
 *
 * Plumbing only: whether a kind may be applied, and by whom, is the server's
 * decision. It authorizes every request against the API key.
 */

import { ContextNestError } from "@promptowl/contextnest-engine";
import chalk from "./color.js";
import type { KindSection } from "./pull.js";
import { NO_REDIRECT, assertNotRedirected } from "./safety.js";

export interface KindTarget {
  /** Server base URL, already checked with assertSafeEndpoint. */
  server: string;
  nest: string;
  apiKey: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export interface KindRequest {
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
}

export interface KindStep {
  kind: "edge-type" | "edge" | "schedule" | "plugin" | "steward";
  /** One line naming the entry, for the plan. */
  label: string;
  /** apply = send `request`; exists = already on the server; skip = not sent (see the plan's warnings). */
  action: "apply" | "exists" | "skip";
  request?: KindRequest;
  note?: string;
  /** Set by executeKindPlan. */
  result?: "created" | "updated" | "exists" | "failed";
  error?: string;
}

export interface KindPlan {
  id: string;
  server: string;
  nest: string;
  steps: KindStep[];
  warnings: string[];
  runnerHandlers: string[];
}

const WORKFLOW_PLANE_OFF =
  "the workflow plane is not enabled on this server (an admin turns it on with FEATURE_WORKFLOW_PLANE=true)";
const PLUGINS_OFF = "plugins are not enabled on this server (an admin turns them on with FEATURE_PLUGINS=true)";

// ─── HTTP ───────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  ok: boolean;
  body: any;
}

async function call(target: KindTarget, method: string, path: string, body?: unknown): Promise<Reply> {
  const doFetch = target.fetch ?? fetch;
  const res = await doFetch(`${target.server.replace(/\/$/, "")}${path}`, {
    ...NO_REDIRECT,
    method,
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // A validated server that redirects would carry the bearer token and the
  // kind's contents to a destination nobody checked.
  assertNotRedirected(res, "--server");
  const parsed = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body: parsed };
}

function serverError(reply: Reply): string {
  const message = reply.body && typeof reply.body.error === "string" ? reply.body.error : "";
  return `${reply.status}${message ? ` ${message}` : ""}`;
}

const nestPath = (target: KindTarget, rest = "") => `/nests/${encodeURIComponent(target.nest)}${rest}`;

// ─── Flags ──────────────────────────────────────────────────────────────────

/** `--steward @placeholder=email`, repeatable → `{ "@placeholder": "email" }`. */
export function parseStewardMappings(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const match = /^(@[a-z0-9][a-z0-9._-]*)=(.+)$/i.exec(value.trim());
    if (!match) {
      throw new ContextNestError(`--steward "${value}" must look like @placeholder=person@example.com`, "VALIDATION_FAILED");
    }
    const [, placeholder, rawEmail] = match;
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ContextNestError(`--steward ${placeholder}: "${rawEmail}" is not an email address`, "VALIDATION_FAILED");
    }
    if (placeholder in out) throw new ContextNestError(`--steward ${placeholder} is mapped twice`, "VALIDATION_FAILED");
    out[placeholder] = email;
  }
  return out;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

/**
 * Build the plan: one step per kind entry, in the order the server needs
 * them (edge types before the edges that use them). Sends GETs only.
 */
export async function planKindApply(
  id: string,
  kind: KindSection,
  target: KindTarget,
  opts: { stewards?: Record<string, string> } = {},
): Promise<KindPlan> {
  const mapping = opts.stewards ?? {};
  const placeholders = new Set(kind.stewards.map((s) => s.principal));
  for (const p of Object.keys(mapping)) {
    if (!placeholders.has(p)) {
      throw new ContextNestError(
        `${p} is not a steward placeholder in kind "${id}"` +
          (placeholders.size ? ` (it uses ${[...placeholders].join(", ")})` : " (it declares no stewards)"),
        "VALIDATION_FAILED",
      );
    }
  }

  // The nest first: a bad key or a wrong id is an error, not a pile of skips.
  const nest = await call(target, "GET", nestPath(target));
  if (nest.status === 401 || nest.status === 403) {
    throw new ContextNestError(`${target.server} rejected the API key (${serverError(nest)})`, "PERMISSION_DENIED");
  }
  if (nest.status === 404) {
    throw new ContextNestError(`Nest "${target.nest}" was not found on ${target.server}, or this key cannot see it`, "CONFIG_ERROR");
  }
  if (!nest.ok) throw new ContextNestError(`${target.server} answered ${serverError(nest)}`, "INTERNAL");

  const plan: KindPlan = {
    id,
    server: target.server,
    nest: target.nest,
    steps: [],
    warnings: [],
    runnerHandlers: kind.runner?.handlers ?? [],
  };
  const warn = (message: string) => plan.warnings.push(message);

  // ── Workflow plane: edge types, edges, schedules ──
  const workflowCount = kind.edge_types.length + kind.edges.length + kind.schedules.length;
  let workflowOn = false;
  const existingTypes = new Set<string>();
  const existingSchedules = new Map<string, number>();
  if (workflowCount > 0) {
    const types = await call(target, "GET", nestPath(target, "/edge-types"));
    if (types.status === 404) {
      warn(
        `Skipping ${kind.edge_types.length} edge type(s), ${kind.edges.length} edge(s) and ${kind.schedules.length} schedule(s): ` +
          WORKFLOW_PLANE_OFF,
      );
    } else if (!types.ok) {
      throw new ContextNestError(`Reading edge types failed (${serverError(types)})`, "INTERNAL");
    } else {
      workflowOn = true;
      for (const t of types.body?.edge_types ?? []) existingTypes.add(String(t.name).toLowerCase());
      if (kind.schedules.length > 0) {
        const schedules = await call(target, "GET", nestPath(target, "/schedules"));
        if (!schedules.ok) throw new ContextNestError(`Reading schedules failed (${serverError(schedules)})`, "INTERNAL");
        for (const s of schedules.body?.schedules ?? []) existingSchedules.set(String(s.agent_node), Number(s.every_minutes));
      }
    }
  }
  const workflowSkip = { action: "skip" as const, note: "workflow plane off" };

  for (const t of kind.edge_types) {
    const label = `${t.name}${t.is_flow ? " (flow)" : ""}`;
    plan.steps.push(
      workflowOn
        ? {
            kind: "edge-type",
            label,
            action: "apply",
            note: existingTypes.has(t.name.toLowerCase()) ? "update (already defined)" : "create",
            request: {
              method: "POST",
              path: nestPath(target, "/edge-types"),
              body: {
                name: t.name,
                description: t.description,
                is_flow: t.is_flow === true,
                ...(t.condition_schema ? { condition_schema: t.condition_schema } : {}),
              },
            },
          }
        : { kind: "edge-type", label, ...workflowSkip },
    );
  }

  for (const e of kind.edges) {
    const label = `${e.from} -[${e.type}]-> ${e.to}${e.condition ? ` (${e.condition.mode} condition)` : ""}`;
    let condition: Record<string, unknown> = {};
    if (e.condition) {
      const { mode, ...rest } = e.condition;
      condition = { condition_mode: mode, condition: mode === "structured" ? rest : (rest as { text: string }).text };
    }
    plan.steps.push(
      workflowOn
        ? {
            kind: "edge",
            label,
            action: "apply",
            request: {
              method: "POST",
              path: nestPath(target, "/edges"),
              body: { from_node: e.from, to_node: e.to, type: e.type, ...condition },
            },
          }
        : { kind: "edge", label, ...workflowSkip },
    );
  }

  for (const s of kind.schedules) {
    const label = `${s.agent} every ${s.every_minutes} min`;
    const current = existingSchedules.get(s.agent);
    if (!workflowOn) plan.steps.push({ kind: "schedule", label, ...workflowSkip });
    else if (current !== undefined) {
      // The server keeps one schedule per agent; changing a live cadence is
      // an edit for a person, not a side effect of re-applying a kind.
      plan.steps.push({
        kind: "schedule",
        label,
        action: "exists",
        note: `already scheduled every ${current} min — left as is`,
      });
    } else {
      plan.steps.push({
        kind: "schedule",
        label,
        action: "apply",
        request: {
          method: "POST",
          path: nestPath(target, "/schedules"),
          body: { agent_node: s.agent, every_minutes: s.every_minutes },
        },
      });
    }
  }

  // ── Plugins ──
  if (kind.plugins.length > 0) {
    const listed = await call(target, "GET", nestPath(target, "/plugins"));
    let loaded: Map<string, { secretKeys: string[]; configured: boolean }> | null = null;
    if (listed.status === 404) {
      warn(`Skipping ${kind.plugins.length} plugin(s): ${PLUGINS_OFF}`);
    } else if (!listed.ok) {
      throw new ContextNestError(`Reading plugins failed (${serverError(listed)})`, "INTERNAL");
    } else {
      loaded = new Map();
      for (const p of listed.body?.plugins ?? []) {
        loaded.set(String(p.name).toLowerCase(), {
          secretKeys: Array.isArray(p.secretKeys) ? p.secretKeys.map(String) : [],
          configured: p.configured === true,
        });
      }
    }
    for (const p of kind.plugins) {
      const label = `${p.name} (${p.mode})`;
      if (!loaded) {
        plan.steps.push({ kind: "plugin", label, action: "skip", note: "plugins off" });
        continue;
      }
      const server = loaded.get(p.name.toLowerCase());
      if (!server) {
        warn(`Skipping: plugin "${p.name}" is not loaded on this server (its operator adds it to PLUGINS)`);
        plan.steps.push({ kind: "plugin", label, action: "skip", note: "not loaded" });
        continue;
      }
      // The recipe parser refuses secret-looking settings; the server knows
      // exactly which keys are secret, so check against that too.
      const secret = Object.keys(p.settings ?? {}).filter((k) => server.secretKeys.includes(k));
      if (secret.length) {
        warn(
          `Refusing plugin "${p.name}": ${secret.join(", ")} is a secret setting of "${p.name}" — set it on the server, never in a recipe`,
        );
        plan.steps.push({ kind: "plugin", label, action: "skip", note: "carries a secret setting" });
        continue;
      }
      plan.steps.push({
        kind: "plugin",
        label,
        action: "apply",
        // Never `enabled`: a plugin starts pulling once enabled, and that
        // waits for a person to connect its secrets on the server.
        note: `${server.configured ? "merge into existing config" : "configure"}; enable it on the server once its secrets are set`,
        request: {
          method: "PUT",
          path: nestPath(target, `/plugins/${encodeURIComponent(p.name)}`),
          body: { mode: p.mode, ...(p.settings ? { settings: p.settings } : {}) },
        },
      });
    }
  }

  // ── Stewards ──
  const unresolved = new Set<string>();
  for (const s of kind.stewards) {
    const scopeLabel = s.scope === "nest" ? "nest" : s.scope === "tag" ? `tag #${s.target}` : `document ${s.target}`;
    const email = mapping[s.principal];
    const label = `${s.role} of ${scopeLabel} → ${email ?? s.principal}`;
    if (!email) {
      unresolved.add(s.principal);
      plan.steps.push({ kind: "steward", label, action: "skip", note: "unresolved placeholder" });
      continue;
    }
    plan.steps.push({
      kind: "steward",
      label,
      action: "apply",
      request: {
        method: "POST",
        path: nestPath(target, "/stewards"),
        body: {
          scope: s.scope,
          ...(s.scope === "document" ? { documentId: s.target } : {}),
          ...(s.scope === "tag" ? { tagName: s.target } : {}),
          users: [{ email, role: s.role }],
        },
      },
    });
  }
  if (unresolved.size > 0) {
    warn(
      `Not applying stewards for unresolved placeholder(s) ${[...unresolved].join(", ")} — map each to a person with ` +
        [...unresolved].map((p) => `--steward ${p}=<email>`).join(" "),
    );
  }
  if (plan.steps.some((s) => s.kind === "steward" && s.action === "apply")) {
    warn("Assigning a steward turns governance (stewardship) on for the nest, if it is not on already.");
  }

  return plan;
}

// ─── Execute ────────────────────────────────────────────────────────────────

/**
 * Send every `apply` step, in plan order, and record each outcome on the
 * step. A failure does not stop the run: the rest of the plan is independent
 * enough to be worth landing, and the report names what did not.
 */
export async function executeKindPlan(plan: KindPlan, target: KindTarget): Promise<KindPlan> {
  for (const step of plan.steps) {
    if (step.action !== "apply" || !step.request) continue;
    const { method, path, body } = step.request;
    let reply: Reply;
    try {
      reply = await call(target, method, path, body);
    } catch (err) {
      step.result = "failed";
      step.error = (err as Error).message;
      continue;
    }
    if (reply.status === 201) step.result = "created";
    else if (reply.ok) step.result = "updated";
    else if (reply.status === 409) {
      step.result = "exists";
      step.error = serverError(reply);
    } else {
      step.result = "failed";
      step.error =
        reply.status === 404 && step.kind !== "steward"
          ? `${serverError(reply)} — ${step.kind === "plugin" ? PLUGINS_OFF : WORKFLOW_PLANE_OFF}?`
          : serverError(reply);
    }
  }
  return plan;
}

// ─── Output ─────────────────────────────────────────────────────────────────

const MARKS: Record<KindStep["action"], string> = {
  apply: chalk.green("+ apply "),
  exists: chalk.dim("= exists"),
  skip: chalk.yellow("- skip  "),
};

const RESULT_MARKS: Record<NonNullable<KindStep["result"]>, string> = {
  created: chalk.green("✓ created"),
  updated: chalk.green("✓ updated"),
  exists: chalk.dim("= exists "),
  failed: chalk.red("✗ failed "),
};

/** The plan (or, once executed, the outcome) as printable lines. */
export function renderKindPlan(plan: KindPlan): string[] {
  const lines: string[] = [];
  const groups: Array<[KindStep["kind"], string]> = [
    ["edge-type", "Edge types"],
    ["edge", "Edges"],
    ["schedule", "Schedules"],
    ["plugin", "Plugins"],
    ["steward", "Stewards"],
  ];
  for (const [kind, title] of groups) {
    const steps = plan.steps.filter((s) => s.kind === kind);
    if (steps.length === 0) continue;
    lines.push(chalk.bold(title));
    for (const s of steps) {
      const mark = s.result ? RESULT_MARKS[s.result] : MARKS[s.action];
      const req = s.request && !s.result ? chalk.dim(`  ${s.request.method} ${s.request.path}`) : "";
      const tail = s.error ? chalk.dim(` — ${s.error}`) : s.note ? chalk.dim(` — ${s.note}`) : "";
      lines.push(`  ${mark} ${s.label}${tail}${req}`);
    }
  }
  if (plan.runnerHandlers.length > 0) {
    lines.push(chalk.bold("Runner"));
    lines.push(`  expects handler(s): ${plan.runnerHandlers.join(", ")} ${chalk.dim("(informational — not checked)")}`);
  }
  for (const w of plan.warnings) lines.push(chalk.yellow(`! ${w}`));
  return lines;
}
