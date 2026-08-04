/**
 * Tier 1 — pure unit tests for the shared core. Each run() is called with a
 * fake `exec` returning canned ctx JSON; no subprocess, no real vault.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as retrieve } from "../shared/core/retrieve.js";
import { run as sessionStart } from "../shared/core/session-start.js";
import { run as captureGate, isSubstantive } from "../shared/core/capture-gate.js";
import {
  getConfig,
  vaultTargets,
  isVaultRegistered,
  withVault,
  ctxJson,
  squish,
  VALID_RETRIEVAL_MODES,
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

// getConfig() reads real override files when the caller doesn't inject
// cwd/homedir (sessionStart never does). Point HOME and the project dir at an
// empty temp dir so a developer's own ~/.contextnest/plugin-settings.json can't
// leak into these assertions. Node's os.homedir() honours $HOME on POSIX.
const realHome = process.env.HOME;
const realProjectDir = process.env.CLAUDE_PROJECT_DIR;
beforeAll(() => {
  const empty = mkdtempSync(join(tmpdir(), "cn-no-settings-"));
  process.env.HOME = empty;
  process.env.CLAUDE_PROJECT_DIR = empty;
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = realProjectDir;
});

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

describe("getConfig settings override files (CU-wdqcpzw825)", () => {
  /**
   * Build throwaway project/user dirs with optional override files.
   *  - project: <cwd>/.claude/contextnest.local.json
   *  - user:    <home>/.contextnest/plugin-settings.json
   */
  function tempSettings(project?: unknown, user?: unknown) {
    const cwd = mkdtempSync(join(tmpdir(), "cn-proj-"));
    const homedir = mkdtempSync(join(tmpdir(), "cn-home-"));
    if (project !== undefined) {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude", "contextnest.local.json"),
        typeof project === "string" ? project : JSON.stringify(project),
      );
    }
    if (user !== undefined) {
      mkdirSync(join(homedir, ".contextnest"), { recursive: true });
      writeFileSync(
        join(homedir, ".contextnest", "plugin-settings.json"),
        typeof user === "string" ? user : JSON.stringify(user),
      );
    }
    return { cwd, homedir };
  }

  // Enable-time answers, frozen into env by Claude Code. The bug: these used
  // to be the ONLY source, so settings could never be changed after enable.
  const enableTimeEnv = {
    CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE: "search",
    CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE: "true",
    CLAUDE_PLUGIN_OPTION_VAULT: "work",
  };

  it("project override file beats the stale enable-time env value", () => {
    const opts = tempSettings({ retrieval_mode: "off" });
    expect(getConfig(enableTimeEnv, opts).retrievalMode).toBe("off");
  });

  it("auto_capture:false in the project file disables capture despite env true", () => {
    const opts = tempSettings({ auto_capture: false });
    expect(getConfig(enableTimeEnv, opts).autoCapture).toBe(false);
  });

  it("user-level file beats env; project file beats user file", () => {
    const fromUser = tempSettings(undefined, { retrieval_mode: "agent" });
    expect(getConfig(enableTimeEnv, fromUser).retrievalMode).toBe("agent");

    const both = tempSettings({ retrieval_mode: "query" }, { retrieval_mode: "agent" });
    expect(getConfig(enableTimeEnv, both).retrievalMode).toBe("query");
  });

  it('an explicit vault:"" in the file unpins an enable-time pinned vault', () => {
    const opts = tempSettings({ vault: "" });
    expect(getConfig(enableTimeEnv, opts).vault).toBe("");
  });

  it("keys absent from the file fall through to env, then defaults", () => {
    const opts = tempSettings({ retrieval_mode: "off" });
    const c = getConfig(enableTimeEnv, opts);
    expect(c.vault).toBe("work"); // untouched by file → env wins
    expect(c.ctxCommand).toBe("ctx"); // nowhere → default
  });

  it("missing or malformed override files never throw and leave env in charge", () => {
    const none = tempSettings(); // dirs exist, no files
    expect(getConfig(enableTimeEnv, none).retrievalMode).toBe("search");

    const broken = tempSettings("{not json", "[1,2,3]");
    const c = getConfig(enableTimeEnv, broken);
    expect(c.retrievalMode).toBe("search");
    expect(c.autoCapture).toBe(true);
  });

  // retrieval_mode is the one setting with a fixed value set. A wrong value
  // (typo, stale, wrong case) must never silently degrade to "search" while
  // looking set — it is skipped per layer, so resolution falls through.
  describe("invalid retrieval_mode is rejected, not silently mis-applied", () => {
    it("a bogus value in the only layer falls back to the search default", () => {
      const opts = tempSettings({ retrieval_mode: "aggressive" });
      expect(getConfig({}, opts).retrievalMode).toBe("search");
    });

    it("a bogus project value is skipped so a valid env value still wins", () => {
      const opts = tempSettings({ retrieval_mode: "turbo" });
      // enable-time env is a valid "search"; the junk file must not mask it.
      expect(getConfig(enableTimeEnv, opts).retrievalMode).toBe("search");
    });

    it("a bogus project value is skipped so a valid user-file value wins", () => {
      const opts = tempSettings({ retrieval_mode: "nope" }, { retrieval_mode: "agent" });
      expect(getConfig({}, opts).retrievalMode).toBe("agent");
    });

    it("normalizes surrounding whitespace and casing before validating", () => {
      const opts = tempSettings({ retrieval_mode: "  AGENT  " });
      expect(getConfig({}, opts).retrievalMode).toBe("agent");
    });

    it("every accepted mode round-trips through a file override", () => {
      for (const mode of VALID_RETRIEVAL_MODES) {
        const opts = tempSettings({ retrieval_mode: mode });
        expect(getConfig({}, opts).retrievalMode).toBe(mode);
      }
    });

    it("a non-string junk value (number) is rejected too", () => {
      const opts = tempSettings({ retrieval_mode: 42 });
      expect(getConfig({}, opts).retrievalMode).toBe("search");
    });
  });

  describe("auto_capture accepts only boolean spellings", () => {
    it("recognized truthy/falsy spellings resolve as expected", () => {
      for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) {
        expect(getConfig({}, tempSettings({ auto_capture: v })).autoCapture).toBe(true);
      }
      for (const v of ["false", "0", "no", "off", "OFF", " No "]) {
        expect(getConfig({}, tempSettings({ auto_capture: v })).autoCapture).toBe(false);
      }
    });

    it("a JSON boolean (not a string) is honoured", () => {
      expect(getConfig({}, tempSettings({ auto_capture: false })).autoCapture).toBe(false);
      expect(getConfig({}, tempSettings({ auto_capture: true })).autoCapture).toBe(true);
    });

    it("a garbage value is skipped → default ON, and cannot mask a valid layer", () => {
      // Junk in the only layer → default ON.
      expect(getConfig({}, tempSettings({ auto_capture: "banana" })).autoCapture).toBe(true);
      // Junk project value must not hide a valid "off" in the user file.
      const both = tempSettings({ auto_capture: "2" }, { auto_capture: "off" });
      expect(getConfig({}, both).autoCapture).toBe(false);
    });
  });

  describe("vault accepts only the unpin sentinel or a shape-valid alias", () => {
    it("a shape-valid alias passes through", () => {
      expect(getConfig({}, tempSettings({ vault: "work-2_v1" })).vault).toBe("work-2_v1");
    });

    it("a malformed alias is skipped → default unpinned, cannot mask a valid layer", () => {
      for (const bad of ["my vault", "a/b", "..", "work!"]) {
        expect(getConfig({}, tempSettings({ vault: bad })).vault).toBe("");
      }
      // Junk project value must not hide a valid alias in the user file.
      const both = tempSettings({ vault: "a/b" }, { vault: "home" });
      expect(getConfig({}, both).vault).toBe("home");
    });

    it('an explicit "" still unpins (not treated as malformed)', () => {
      const env = { CLAUDE_PLUGIN_OPTION_VAULT: "work" };
      expect(getConfig(env, tempSettings({ vault: "" })).vault).toBe("");
    });
  });

  describe("ctx_command is trimmed and must be non-empty", () => {
    it("surrounding whitespace is trimmed; internal spaces are preserved", () => {
      expect(getConfig({}, tempSettings({ ctx_command: "  /bin/ctx  " })).ctxCommand).toBe("/bin/ctx");
      // A path with internal spaces is a legitimate argv[0] for execFileSync.
      expect(getConfig({}, tempSettings({ ctx_command: "/opt/my ctx/ctx" })).ctxCommand).toBe(
        "/opt/my ctx/ctx",
      );
    });

    it("a blank value is skipped → default 'ctx', cannot mask a valid layer", () => {
      expect(getConfig({}, tempSettings({ ctx_command: "   " })).ctxCommand).toBe("ctx");
      const both = tempSettings({ ctx_command: "" }, { ctx_command: "/usr/local/bin/ctx" });
      expect(getConfig({}, both).ctxCommand).toBe("/usr/local/bin/ctx");
    });
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

  it("vaultTargets: a registered pin is honoured; unpinned fans out; empty registry → [null]", () => {
    const ex = fakeExec([["vault list", [{ alias: "a", exists: true }, { alias: "b", exists: true }]]]);
    expect(vaultTargets(getConfig({ CONTEXTNEST_VAULT_ALIAS: "a" }), ex)).toEqual(["a"]);
    expect(vaultTargets(getConfig({}), ex)).toEqual(["a", "b"]);
    expect(vaultTargets(getConfig({}), fakeExec([["vault list", []]]))).toEqual([null]);
  });

  it("vaultTargets: a stale pin (not registered) falls back to auto-select, not a bad --vault", () => {
    const twoVaults = fakeExec([["vault list", [{ alias: "a", exists: true }, { alias: "b", exists: true }]]]);
    // "pin" isn't in the registry → behave as unpinned (fan out), never ["pin"].
    expect(vaultTargets(getConfig({ CONTEXTNEST_VAULT_ALIAS: "pin" }), twoVaults)).toEqual(["a", "b"]);
    // Registered but path missing (exists:false) is also not usable → fall back.
    const missing = fakeExec([["vault list", [{ alias: "gone", exists: false }]]]);
    expect(vaultTargets(getConfig({ CONTEXTNEST_VAULT_ALIAS: "gone" }), missing)).toEqual([null]);
  });

  it("isVaultRegistered: true only for a registered, present alias", () => {
    const vaults = [{ alias: "a", exists: true }, { alias: "gone", exists: false }];
    expect(isVaultRegistered("a", vaults)).toBe(true);
    expect(isVaultRegistered("gone", vaults)).toBe(false); // registered but missing on disk
    expect(isVaultRegistered("nope", vaults)).toBe(false); // not registered
    expect(isVaultRegistered("", vaults)).toBe(false); // unpinned
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

  it("warns when the pinned vault is not registered (stale pin)", () => {
    const ex = fakeExec([
      ["vault list", [{ alias: "work", exists: true }, { alias: "home", exists: true }]],
    ]);
    const out = sessionStart({ input: {}, env: { CONTEXTNEST_VAULT_ALIAS: "ghost" }, exec: ex });
    const ctx = additional(out)!;
    expect(ctx).toMatch(/not a registered vault/i);
    expect(ctx).toContain("`ghost`");
    // Must NOT claim the ghost pin is in effect, and no vault is flagged pinned.
    expect(ctx).not.toContain("all queries/captures use it");
    expect(ctx).not.toContain("pinned");
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
