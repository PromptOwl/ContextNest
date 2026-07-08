/**
 * Tier 1 — pure unit tests for the shared core. Each run() is called with a
 * fake `exec` returning canned ctx JSON; no subprocess, no real vault.
 */
import { describe, it, expect } from "vitest";

import { run as retrieve } from "../shared/core/retrieve.js";
import { run as sessionStart } from "../shared/core/session-start.js";
import { run as captureGate, isSubstantive } from "../shared/core/capture-gate.js";
import {
  getConfig,
  vaultTargets,
  withVault,
  ctxJson,
  squish,
} from "../shared/core/lib.js";

/** Build a fake exec from a list of [substringMatch, jsonValue]. */
function fakeExec(routes: [string, unknown][], fallback: unknown = []) {
  return (args: string[]) => {
    const key = args.join(" ");
    for (const [match, val] of routes) {
      if (key.includes(match)) {
        return { status: 0, stdout: JSON.stringify(val), stderr: "" };
      }
    }
    return { status: 0, stdout: JSON.stringify(fallback), stderr: "" };
  };
}

function additional(out: any): string | undefined {
  return out?.hookSpecificOutput?.additionalContext;
}

describe("getConfig", () => {
  it("defaults and Claude userConfig precedence", () => {
    expect(getConfig({}).retrievalMode).toBe("search");
    expect(getConfig({}).autoCapture).toBe(true);
    expect(getConfig({}).vault).toBe("");
    expect(getConfig({}).ctxCommand).toBe("ctx");

    const env = {
      CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE: "QUERY",
      CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE: "false",
      CLAUDE_PLUGIN_OPTION_VAULT: "work",
      CLAUDE_PLUGIN_OPTION_CTX_COMMAND: "/bin/ctx",
    };
    const c = getConfig(env);
    expect(c.retrievalMode).toBe("query");
    expect(c.autoCapture).toBe(false);
    expect(c.vault).toBe("work");
    expect(c.ctxCommand).toBe("/bin/ctx");
  });

  it("generic CONTEXTNEST_* fallbacks when no Claude option is set", () => {
    const c = getConfig({ CONTEXTNEST_RETRIEVAL_MODE: "agent", CONTEXTNEST_VAULT_ALIAS: "p" });
    expect(c.retrievalMode).toBe("agent");
    expect(c.vault).toBe("p");
  });
});

describe("lib helpers", () => {
  it("withVault appends only when an alias is given", () => {
    expect(withVault(["search", "x", "--json"], "work")).toEqual([
      "search",
      "x",
      "--json",
      "--vault",
      "work",
    ]);
    expect(withVault(["search"], "")).toEqual(["search"]);
  });

  it("ctxJson returns fallback on non-zero exit or bad JSON", () => {
    expect(ctxJson(() => ({ status: 1, stdout: "" }), ["x"], "fb")).toBe("fb");
    expect(ctxJson(() => ({ status: 0, stdout: "not json" }), ["x"], "fb")).toBe("fb");
    expect(ctxJson(() => ({ status: 0, stdout: "[1,2]" }), ["x"], null)).toEqual([1, 2]);
  });

  it("vaultTargets: pinned beats registry; empty registry → [null]", () => {
    const ex = fakeExec([["vault list", [{ alias: "a", exists: true }, { alias: "b", exists: true }]]]);
    expect(vaultTargets(getConfig({ CONTEXTNEST_VAULT_ALIAS: "pin" }), ex)).toEqual(["pin"]);
    expect(vaultTargets(getConfig({}), ex)).toEqual(["a", "b"]);
    expect(vaultTargets(getConfig({}), fakeExec([["vault list", []]]))).toEqual([null]);
  });

  it("squish collapses whitespace and truncates", () => {
    expect(squish("a   b\n c")).toBe("a b c");
    expect(squish("abcdef", 4)).toBe("abc…");
  });
});

describe("retrieve", () => {
  const env = (mode: string) => ({ CONTEXTNEST_RETRIEVAL_MODE: mode });

  it("off → null", () => {
    expect(retrieve({ input: { prompt: "auth" }, env: env("off"), exec: fakeExec([]) })).toBeNull();
  });

  it("agent → injects a directive to invoke the retriever", () => {
    const out = retrieve({ input: { prompt: "x" }, env: env("agent"), exec: fakeExec([]) });
    expect(additional(out)).toMatch(/contextnest-retriever/);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("search → injects top hits from ctx search (empty registry, default vault)", () => {
    const ex = fakeExec([
      ["vault list", []],
      ["search auth", [{ id: "nodes/alpha", title: "Alpha Auth", type: "document" }]],
    ]);
    const out = retrieve({ input: { prompt: "auth" }, env: env("search"), exec: ex });
    expect(additional(out)).toContain("nodes/alpha — Alpha Auth (document)");
  });

  it("search → null when there are no hits", () => {
    const ex = fakeExec([["vault list", []], ["search nope", []]]);
    expect(retrieve({ input: { prompt: "nope" }, env: env("search"), exec: ex })).toBeNull();
  });

  it("search fans out across registered vaults and labels refs vault:id", () => {
    const ex = (args: string[]) => {
      const k = args.join(" ");
      if (k.includes("vault list")) {
        return json([{ alias: "work", exists: true }, { alias: "home", exists: true }]);
      }
      if (k.includes("--vault work")) return json([{ id: "nodes/w", title: "W", type: "document" }]);
      if (k.includes("--vault home")) return json([{ id: "nodes/h", title: "H", type: "document" }]);
      return json([]);
    };
    const out = retrieve({ input: { prompt: "topic" }, env: env("search"), exec: ex });
    expect(additional(out)).toContain("work:nodes/w");
    expect(additional(out)).toContain("home:nodes/h");
  });

  it("query → maps ids to tags via ctx list then injects graph documents", () => {
    const ex = (args: string[]) => {
      const k = args.join(" ");
      if (k.includes("vault list")) return json([]);
      if (k.startsWith("search")) return json([{ id: "nodes/alpha", title: "Alpha", type: "document" }]);
      if (k.startsWith("list")) return json([{ id: "nodes/alpha", title: "Alpha", tags: ["#security"] }]);
      if (k.startsWith("query")) {
        // selector must be derived from the seed's tag
        expect(k).toContain("#security");
        return json({ documents: [{ id: "nodes/alpha", title: "Alpha", body: "JWT rotation." }], sourceNodes: [] });
      }
      return json([]);
    };
    const out = retrieve({ input: { prompt: "auth" }, env: env("query"), exec: ex });
    expect(additional(out)).toContain("nodes/alpha — Alpha");
    expect(additional(out)).toContain("JWT rotation.");
  });

  it("uses user_prompt field when prompt is absent", () => {
    const ex = fakeExec([
      ["vault list", []],
      ["search hello", [{ id: "nodes/x", title: "X", type: "document" }]],
    ]);
    const out = retrieve({ input: { user_prompt: "hello" }, env: env("search"), exec: ex });
    expect(additional(out)).toContain("nodes/x");
  });

  function json(v: unknown) {
    return { status: 0, stdout: JSON.stringify(v), stderr: "" };
  }
});

describe("session-start", () => {
  it("warns when ctx is unavailable", () => {
    const out = sessionStart({ input: {}, env: {}, exec: () => ({ status: 1, stdout: "", code: "ENOENT" }) });
    expect(additional(out)).toMatch(/not available/i);
  });

  it("lists registered vaults and marks pinned/default", () => {
    const ex = fakeExec([
      ["vault list", [
        { alias: "work", description: "work stuff", isDefault: true, exists: true },
        { alias: "home", description: "personal", exists: true },
      ]],
    ]);
    const out = sessionStart({ input: {}, env: { CONTEXTNEST_VAULT_ALIAS: "home" }, exec: ex });
    const ctx = additional(out)!;
    expect(ctx).toContain("`work`");
    expect(ctx).toContain("default");
    expect(ctx).toContain("pinned");
  });

  it("notes local resolution when no vaults are registered", () => {
    const out = sessionStart({ input: {}, env: {}, exec: fakeExec([["vault list", []]]) });
    expect(additional(out)).toMatch(/No vaults are registered/i);
  });
});

describe("capture-gate", () => {
  it("allows when auto-capture disabled", () => {
    expect(captureGate({ input: {}, env: { CONTEXTNEST_AUTO_CAPTURE: "false" }, readTail: () => [] })).toBeNull();
  });

  it("allows on the stop_hook_active loop guard", () => {
    expect(captureGate({ input: { stop_hook_active: true }, env: {}, readTail: () => ["x"] })).toBeNull();
  });

  it("blocks on a substantive turn and names the capture agent", () => {
    const out = captureGate({
      input: { transcript_path: "t" },
      env: {},
      readTail: () => ['{"role":"user"}', '{"role":"assistant","content":[{"tool_use":1}]}'],
    });
    expect(out?.decision).toBe("block");
    expect(out?.reason).toMatch(/contextnest-capture/);
  });

  it("allows a trivial no-tool short turn", () => {
    const out = captureGate({
      input: { transcript_path: "t" },
      env: {},
      readTail: () => ['{"role":"user"}', '{"role":"assistant"} hi'],
    });
    expect(out).toBeNull();
  });

  it("CONTEXTNEST_CAPTURE_ALWAYS forces a block", () => {
    const out = captureGate({ input: {}, env: { CONTEXTNEST_CAPTURE_ALWAYS: "1" }, readTail: () => [] });
    expect(out?.decision).toBe("block");
  });

  it("isSubstantive: tool use → true, empty tail → true (favour capture)", () => {
    expect(isSubstantive(['{"role":"assistant","tool_use":1}'])).toBe(true);
    expect(isSubstantive([])).toBe(true);
    expect(isSubstantive(['{"role":"user"}', '{"role":"assistant"} short'])).toBe(false);
  });
});
