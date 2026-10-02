/**
 * `ctx kind apply` — the plan a pulled kind turns into against a Community
 * server, feature detection of the flag-gated planes, steward placeholder
 * resolution, and execution.
 *
 * `fetch` is injected: a small fake server routes (method, path) to canned
 * responses and records every call, so the assertions can check exactly what
 * would leave the machine — and that a dry run sends nothing but GETs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ContextNestError } from "@promptowl/contextnest-engine";
import { parseRecipeManifest } from "../pull.js";
import type { KindSection } from "../pull.js";
import {
  planKindApply,
  executeKindPlan,
  renderKindPlan,
  parseStewardMappings,
  type KindTarget,
} from "../kind.js";

// ─── Fake server ────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth?: string | null;
}

type Reply = { status: number; body?: unknown };
type Route = (call: Call) => Reply | undefined;

let calls: Call[] = [];
let routes: Record<string, Route | Reply> = {};

function key(method: string, path: string): string {
  return `${method} ${path}`;
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const call: Call = {
    method,
    path: url.pathname,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    auth: headers.get("authorization"),
  };
  calls.push(call);
  const route = routes[key(method, url.pathname)];
  const reply = (typeof route === "function" ? route(call) : route) ?? { status: 404, body: { error: "Not found" } };
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "Content-Type": "application/json" },
  });
};

const target: KindTarget = { server: "https://cn.example.com", nest: "n1", apiKey: "cnst_test", fetch: fakeFetch };

/** Every plane on: the nest exists, the workflow plane and plugins answer. */
function fullServer(): void {
  routes = {
    [key("GET", "/nests/n1")]: { status: 200, body: { id: "n1", name: "Seam" } },
    [key("GET", "/nests/n1/edge-types")]: {
      status: 200,
      body: { count: 1, edge_types: [{ id: "t1", name: "next", is_flow: true }] },
    },
    [key("GET", "/nests/n1/schedules")]: { status: 200, body: { count: 0, schedules: [] } },
    [key("GET", "/nests/n1/plugins")]: {
      status: 200,
      body: { plugins: [{ name: "github", secretKeys: ["token"], configured: false, enabled: false }], load_errors: [] },
    },
    [key("POST", "/nests/n1/edge-types")]: { status: 201, body: { edge_type: {} } },
    [key("POST", "/nests/n1/edges")]: { status: 201, body: { edge: {} } },
    [key("POST", "/nests/n1/schedules")]: { status: 201, body: { schedule: {} } },
    [key("PUT", "/nests/n1/plugins/github")]: { status: 200, body: { plugin: {} } },
    [key("POST", "/nests/n1/stewards")]: { status: 201, body: { stewards: [] } },
  };
}

const KIND = `id: seam
kind:
  plugins:
    - name: github
      mode: summary
      settings:
        repos: [promptowl/contextnest]
  edge_types:
    - name: escalates-when
      description: Escalate when the condition holds.
      is_flow: true
      condition_schema:
        params: [CAC]
  edges:
    - from: nodes/a
      to: nodes/b
      type: escalates-when
      condition:
        mode: structured
        term: CAC
        op: ">"
        value: 500
    - from: nodes/b
      to: nodes/c
      type: next
      condition:
        mode: nl
        text: when b found something
  schedules:
    - agent: nodes/agents/triage
      every_minutes: 60
  stewards:
    - scope: document
      target: nodes/a
      role: reviewer
      principal: "@seam-owner"
    - scope: tag
      target: seam
      role: editor
      principal: "@seam-editors"
  runner:
    handlers: [llm-judge]
`;

const kind = (): KindSection => parseRecipeManifest("```yaml recipe\n" + KIND + "\n```\n").kind!;

beforeEach(() => {
  calls = [];
  fullServer();
});

const mutations = () => calls.filter((c) => c.method !== "GET");

// ─── Plan ───────────────────────────────────────────────────────────────────

describe("planKindApply", () => {
  it("plans every request in dependency order and sends nothing but GETs", async () => {
    const plan = await planKindApply("seam", kind(), target, { stewards: { "@seam-owner": "owner@example.com", "@seam-editors": "eds@example.com" } });
    expect(plan.steps.map((s) => `${s.kind}:${s.action}`)).toEqual([
      "edge-type:apply",
      "edge:apply",
      "edge:apply",
      "schedule:apply",
      "plugin:apply",
      "steward:apply",
      "steward:apply",
    ]);
    expect(plan.steps[0].request).toEqual({
      method: "POST",
      path: "/nests/n1/edge-types",
      body: {
        name: "escalates-when",
        description: "Escalate when the condition holds.",
        is_flow: true,
        condition_schema: { params: ["CAC"] },
      },
    });
    expect(plan.steps[1].request?.body).toEqual({
      from_node: "nodes/a",
      to_node: "nodes/b",
      type: "escalates-when",
      condition_mode: "structured",
      condition: { term: "CAC", op: ">", value: 500 },
    });
    expect(plan.steps[2].request?.body).toEqual({
      from_node: "nodes/b",
      to_node: "nodes/c",
      type: "next",
      condition_mode: "nl",
      condition: "when b found something",
    });
    expect(plan.steps[3].request).toEqual({
      method: "POST",
      path: "/nests/n1/schedules",
      body: { agent_node: "nodes/agents/triage", every_minutes: 60 },
    });
    // Configured, not enabled: a human enables it once its secrets are set.
    expect(plan.steps[4].request).toEqual({
      method: "PUT",
      path: "/nests/n1/plugins/github",
      body: { mode: "summary", settings: { repos: ["promptowl/contextnest"] } },
    });
    expect(plan.steps[5].request?.body).toEqual({
      scope: "document",
      documentId: "nodes/a",
      users: [{ email: "owner@example.com", role: "reviewer" }],
    });
    expect(plan.steps[6].request?.body).toEqual({
      scope: "tag",
      tagName: "seam",
      users: [{ email: "eds@example.com", role: "editor" }],
    });
    expect(plan.runnerHandlers).toEqual(["llm-judge"]);

    expect(mutations()).toEqual([]);
    expect(calls.every((c) => c.auth === "Bearer cnst_test")).toBe(true);

    const text = renderKindPlan(plan).join("\n");
    expect(text).toContain("POST /nests/n1/edge-types");
    expect(text).toContain("PUT /nests/n1/plugins/github");
    expect(text).toMatch(/llm-judge/);
  });

  it("marks an existing edge type as an update and an existing schedule as present", async () => {
    routes[key("GET", "/nests/n1/edge-types")] = {
      status: 200,
      body: { count: 1, edge_types: [{ id: "t9", name: "Escalates-When", is_flow: false }] },
    };
    routes[key("GET", "/nests/n1/schedules")] = {
      status: 200,
      body: { count: 1, schedules: [{ id: "s1", agent_node: "nodes/agents/triage", every_minutes: 15 }] },
    };
    const plan = await planKindApply("seam", kind(), target);
    expect(plan.steps[0].action).toBe("apply");
    expect(plan.steps[0].note).toMatch(/update/);
    const schedule = plan.steps.find((s) => s.kind === "schedule")!;
    expect(schedule.action).toBe("exists");
    expect(schedule.note).toMatch(/every 15 min/);
  });

  it("turns a 404 on the workflow plane into a clear skip, not a crash", async () => {
    const off = {
      status: 404,
      body: { error: "The workflow plane is not enabled on this server. An admin can turn it on with FEATURE_WORKFLOW_PLANE=true." },
    };
    routes[key("GET", "/nests/n1/edge-types")] = off;
    routes[key("GET", "/nests/n1/schedules")] = off;
    const plan = await planKindApply("seam", kind(), target);
    for (const s of plan.steps.filter((s) => ["edge-type", "edge", "schedule"].includes(s.kind))) {
      expect(s.action).toBe("skip");
      expect(s.request).toBeUndefined();
    }
    expect(plan.warnings.join("\n")).toMatch(/workflow plane is not enabled on this server/);
    expect(plan.warnings.join("\n")).toMatch(/FEATURE_WORKFLOW_PLANE/);
    // The other planes are unaffected.
    expect(plan.steps.find((s) => s.kind === "plugin")!.action).toBe("apply");
  });

  it("feature-detects plugins: a 404 skips them with a warning", async () => {
    routes[key("GET", "/nests/n1/plugins")] = { status: 404, body: { error: "Not found" } };
    const plan = await planKindApply("seam", kind(), target);
    const plugin = plan.steps.find((s) => s.kind === "plugin")!;
    expect(plugin.action).toBe("skip");
    expect(plan.warnings.join("\n")).toMatch(/plugins are not enabled on this server.*FEATURE_PLUGINS/);
  });

  it("skips a plugin the server has not loaded, and refuses a setting the server marks secret", async () => {
    routes[key("GET", "/nests/n1/plugins")] = { status: 200, body: { plugins: [], load_errors: [] } };
    let plan = await planKindApply("seam", kind(), target);
    expect(plan.steps.find((s) => s.kind === "plugin")!.action).toBe("skip");
    expect(plan.warnings.join("\n")).toMatch(/plugin "github" is not loaded on this server/);

    routes[key("GET", "/nests/n1/plugins")] = {
      status: 200,
      body: { plugins: [{ name: "github", secretKeys: ["repos"] }], load_errors: [] },
    };
    plan = await planKindApply("seam", kind(), target);
    const plugin = plan.steps.find((s) => s.kind === "plugin")!;
    expect(plugin.action).toBe("skip");
    expect(plugin.request).toBeUndefined();
    expect(plan.warnings.join("\n")).toMatch(/repos is a secret setting of "github".*set it on the server/);
  });

  it("refuses stewards whose placeholders are unresolved, naming the flag that resolves them", async () => {
    const plan = await planKindApply("seam", kind(), target, { stewards: { "@seam-owner": "owner@example.com" } });
    const stewards = plan.steps.filter((s) => s.kind === "steward");
    expect(stewards.map((s) => s.action)).toEqual(["apply", "skip"]);
    expect(plan.warnings.join("\n")).toMatch(/@seam-editors.*--steward @seam-editors=<email>/);
  });

  it("rejects a steward mapping for a placeholder the kind does not use", async () => {
    await expect(planKindApply("seam", kind(), target, { stewards: { "@nobody": "x@example.com" } })).rejects.toThrow(
      /@nobody is not a steward placeholder in kind "seam"/,
    );
  });

  it("stops on auth and missing-nest errors before planning anything", async () => {
    routes[key("GET", "/nests/n1")] = { status: 401, body: { error: "Unauthorized" } };
    await expect(planKindApply("seam", kind(), target)).rejects.toThrow(/rejected the API key \(401/);
    routes[key("GET", "/nests/n1")] = { status: 404, body: { error: "Nest not found" } };
    await expect(planKindApply("seam", kind(), target)).rejects.toThrow(/Nest "n1" was not found/);
  });

  it("refuses a server that redirects", async () => {
    routes[key("GET", "/nests/n1")] = { status: 302, body: {} };
    await expect(planKindApply("seam", kind(), target)).rejects.toThrow(/redirected/);
  });
});

// ─── Execute ────────────────────────────────────────────────────────────────

describe("executeKindPlan", () => {
  it("sends each planned request in order and records the outcome", async () => {
    const plan = await planKindApply("seam", kind(), target, {
      stewards: { "@seam-owner": "owner@example.com", "@seam-editors": "eds@example.com" },
    });
    calls = [];
    await executeKindPlan(plan, target);
    expect(mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /nests/n1/edge-types",
      "POST /nests/n1/edges",
      "POST /nests/n1/edges",
      "POST /nests/n1/schedules",
      "PUT /nests/n1/plugins/github",
      "POST /nests/n1/stewards",
      "POST /nests/n1/stewards",
    ]);
    expect(plan.steps.map((s) => s.result)).toEqual(["created", "created", "created", "created", "updated", "created", "created"]);
  });

  it("treats a 409 as already present, and keeps going past a failure", async () => {
    let edgeCalls = 0;
    routes[key("POST", "/nests/n1/edges")] = () =>
      ++edgeCalls === 1
        ? { status: 409, body: { error: 'a "escalates-when" connection from "nodes/a" to "nodes/b" already exists' } }
        : { status: 400, body: { error: 'node not found: "nodes/c"' } };
    const plan = await planKindApply("seam", kind(), target, {
      stewards: { "@seam-owner": "owner@example.com", "@seam-editors": "eds@example.com" },
    });
    await executeKindPlan(plan, target);
    const edges = plan.steps.filter((s) => s.kind === "edge");
    expect(edges.map((s) => s.result)).toEqual(["exists", "failed"]);
    expect(edges[1].error).toMatch(/400.*node not found/);
    // Everything after the failure still ran.
    expect(plan.steps.filter((s) => s.kind === "steward").map((s) => s.result)).toEqual(["created", "created"]);
  });

  it("reports a workflow plane switched off mid-run clearly", async () => {
    const plan = await planKindApply("seam", kind(), target);
    routes[key("POST", "/nests/n1/edge-types")] = { status: 404, body: { error: "The workflow plane is not enabled on this server." } };
    await executeKindPlan(plan, target);
    expect(plan.steps[0].result).toBe("failed");
    expect(plan.steps[0].error).toMatch(/workflow plane is not enabled on this server/);
  });

  it("does not send skipped steps", async () => {
    routes[key("GET", "/nests/n1/plugins")] = { status: 404, body: { error: "Not found" } };
    const plan = await planKindApply("seam", kind(), target);
    calls = [];
    await executeKindPlan(plan, target);
    expect(mutations().some((c) => c.path.includes("/plugins") || c.path.endsWith("/stewards"))).toBe(false);
  });
});

// ─── Flags ──────────────────────────────────────────────────────────────────

describe("parseStewardMappings", () => {
  it("reads @placeholder=email pairs", () => {
    expect(parseStewardMappings(["@seam-owner=Owner@Example.com", "@b=b@example.com"])).toEqual({
      "@seam-owner": "owner@example.com",
      "@b": "b@example.com",
    });
  });

  it("refuses malformed and conflicting mappings", () => {
    for (const bad of ["seam-owner=a@example.com", "@x", "@x=not-an-email", "@x="]) {
      expect(() => parseStewardMappings([bad])).toThrow(ContextNestError);
    }
    expect(() => parseStewardMappings(["@x=a@example.com", "@x=b@example.com"])).toThrow(/@x is mapped twice/);
  });
});
