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
import {
  run as captureGate,
  captureSignal,
  isSubstantive,
} from "../shared/core/capture-gate.js";
import {
  correctionIntent,
  countUserTurns,
  explicitCaptureIntent,
  lastUserMessage,
} from "../shared/core/signals.js";
import {
  inCooldown,
  loadLedger,
  saveLedger,
  sessionFileName,
} from "../shared/core/ledger.js";
import {
  getConfig,
  vaultTargets,
  isVaultRegistered,
  withVault,
  ctxJson,
  squish,
  VALID_CAPTURE_MODES,
  VALID_RETRIEVAL_MODES,
} from "../shared/core/lib.js";

/** Transcript stub in the shape the gate's reader returns. */
const tx = (lines: string[], userTurns = countUserTurns(lines)) => () => ({ lines, userTurns });

/** A user message line as Claude Code actually writes it. */
const userLine = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

/** In-memory ledger IO so no test ever touches a real home directory. */
function fakeLedgerIo(seed: Record<string, string> = {}) {
  const files = { ...seed };
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
    files,
  };
}

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
    expect(getConfig({}).captureMode).toBe("propose");
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

  describe("capture_mode supersedes the legacy auto_capture boolean", () => {
    it("defaults to propose, and the legacy boolean maps onto off/propose", () => {
      expect(getConfig({}, tempSettings()).captureMode).toBe("propose");
      expect(getConfig(enableTimeEnv, tempSettings()).captureMode).toBe("propose");
      expect(
        getConfig({ CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE: "false" }, tempSettings()).captureMode,
      ).toBe("off");
    });

    it("every accepted mode round-trips through a file override", () => {
      for (const mode of VALID_CAPTURE_MODES) {
        expect(getConfig(enableTimeEnv, tempSettings({ capture_mode: mode })).captureMode).toBe(mode);
      }
    });

    it("an explicit mode in a file beats a legacy boolean in a higher layer", () => {
      // The legacy key can only say on/off, so a considered mode wins wherever
      // it was set — otherwise nobody with a frozen enable-time answer could
      // ever reach `auto`.
      const opts = tempSettings(undefined, { capture_mode: "auto" });
      expect(getConfig({ ...enableTimeEnv, CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE: "true" }, opts).captureMode).toBe("auto");
    });

    it("a bogus mode is skipped per layer and cannot mask a valid lower one", () => {
      const opts = tempSettings({ capture_mode: "aggressive" }, { capture_mode: "auto" });
      expect(getConfig({}, opts).captureMode).toBe("auto");
      expect(getConfig({}, tempSettings({ capture_mode: "aggressive" })).captureMode).toBe("propose");
    });

    it("normalizes whitespace and casing before validating", () => {
      expect(getConfig({}, tempSettings({ capture_mode: "  AUTO " })).captureMode).toBe("auto");
    });
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

  it("a correction-shaped prompt also gets the change ladder", () => {
    const exec = fakeExec([
      ["vault list", []],
      ["search", [{ id: "nodes/alpha", title: "Alpha Auth", type: "document" }]],
    ]);
    const out = retrieve({ input: { prompt: "actually the timeout is 30s not 60s" }, env: {}, exec });
    const text = additional(out)!;
    expect(text).toMatch(/nodes\/alpha/); // normal retrieval still happens
    expect(text).toMatch(/find EVERY occurrence before editing/);
    expect(text).toMatch(/stop, show the change-set, and ask/);
    // Duplication is the root cause, and surfacing it is not licence to fix it.
    expect(text).toMatch(/offer to make one node canonical/);
    expect(text).toMatch(/offer, don't do it/);
  });

  it("the change ladder is injected even when retrieval finds nothing", () => {
    // Search is ranked and published-only, so zero hits is not evidence the
    // vault is silent — the sweep rule still has to reach the model.
    const out = retrieve({
      input: { prompt: "actually, rename that to Nest" },
      env: {},
      exec: fakeExec([["vault list", []]], []),
    });
    expect(additional(out)).toMatch(/find EVERY occurrence before editing/);
  });

  it("an ordinary prompt pays nothing for the change ladder", () => {
    const exec = fakeExec([
      ["vault list", []],
      ["search", [{ id: "nodes/alpha", title: "Alpha Auth", type: "document" }]],
    ]);
    const out = retrieve({ input: { prompt: "how does auth work" }, env: {}, exec });
    expect(additional(out)).not.toMatch(/change-set/);
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

describe("signals", () => {
  it("lastUserMessage returns the newest human turn, skipping tool_result echoes", () => {
    const lines = [
      userLine("first thing"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
      // tool_result blocks are ALSO type:"user" — the classic false positive.
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "42" }] },
      }),
    ];
    expect(lastUserMessage(lines)).toBe("first thing");
  });

  it("lastUserMessage skips isMeta turns and survives unparseable lines", () => {
    expect(lastUserMessage(["{not json", userLine("real")])).toBe("real");
    expect(lastUserMessage([{ ...JSON.parse(userLine("x")), isMeta: true }].map((o) => JSON.stringify(o)))).toBe("");
    expect(lastUserMessage([])).toBe("");
  });

  it("lastUserMessage handles a plain string content field", () => {
    expect(
      lastUserMessage([JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })]),
    ).toBe("hi");
  });

  it.each([
    "remember that we use pnpm",
    "save this for later",
    "add that to the vault",
    "we decided to drop the cache",
    "from now on, use British spelling",
    "write this down",
  ])("explicitCaptureIntent: %s → true", (t) => {
    expect(explicitCaptureIntent(t)).toBe(true);
  });

  it.each([
    "can you run the tests",
    "what does this function do",
    "fix the failing build",
    "",
  ])("explicitCaptureIntent: %s → false", (t) => {
    expect(explicitCaptureIntent(t)).toBe(false);
  });

  it.each([
    "actually it's 30 seconds not 60",
    "that's wrong, we dropped that",
    "change the timeout to 5s",
    "rename the auth module",
    "no, it's the other way round",
    "replace Redis with Postgres",
    "we no longer support Node 18",
    "the product is now called Nest",
    "update the vault, that entry is stale",
  ])("correctionIntent: %s → true", (t) => {
    expect(correctionIntent(t)).toBe(true);
  });

  it.each(["add a new endpoint", "explain the caching layer", ""])(
    "correctionIntent: %s → false",
    (t) => {
      expect(correctionIntent(t)).toBe(false);
    },
  );

  it("countUserTurns counts human turns only", () => {
    const lines = [
      userLine("one"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "a" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "r" }] },
      }),
      userLine("two"),
    ];
    expect(countUserTurns(lines)).toBe(2);
  });
});

describe("ledger", () => {
  it("rejects session ids that could escape the state directory", () => {
    expect(sessionFileName("../../etc/passwd")).toBeNull();
    expect(sessionFileName("a/b")).toBeNull();
    expect(sessionFileName("")).toBeNull();
    expect(sessionFileName(undefined as unknown as string)).toBeNull();
    expect(sessionFileName("abc-123_DEF")).toBe("abc-123_DEF.json");
  });

  it("round-trips through save → load", () => {
    const io = fakeLedgerIo();
    expect(saveLedger("sess1", { lastGatedTurn: 7, captured: ["a"] }, io)).toBe(true);
    expect(loadLedger("sess1", io)).toEqual({ lastGatedTurn: 7, captured: ["a"] });
  });

  it("an unusable session id persists nothing and loads empty", () => {
    const io = fakeLedgerIo();
    expect(saveLedger("../evil", { lastGatedTurn: 1 }, io)).toBe(false);
    expect(Object.keys(io.files)).toHaveLength(0);
    expect(loadLedger("../evil", io)).toEqual({ lastGatedTurn: null, captured: [] });
  });

  it("a missing or malformed file degrades to empty rather than throwing", () => {
    const io = fakeLedgerIo({ "/fake-home/.contextnest/plugin-state/bad.json": "{oops" });
    expect(loadLedger("bad", io)).toEqual({ lastGatedTurn: null, captured: [] });
    expect(loadLedger("absent", io)).toEqual({ lastGatedTurn: null, captured: [] });
  });

  it("inCooldown: the clock starts at session start, not at the first gate", () => {
    // Never gated, but only two turns in — a short session earns no ambient pass.
    expect(inCooldown({ lastGatedTurn: null, captured: [] }, 2, 5)).toBe(true);
    expect(inCooldown({ lastGatedTurn: null, captured: [] }, 10, 5)).toBe(false);
    expect(inCooldown({ lastGatedTurn: 8, captured: [] }, 10, 5)).toBe(true);
    expect(inCooldown({ lastGatedTurn: 4, captured: [] }, 10, 5)).toBe(false);
  });
});

describe("capture-gate", () => {
  const noLedger = { lastGatedTurn: null, captured: [] };

  it("allows when capture is off, via capture_mode or the legacy boolean", () => {
    for (const env of [{ CONTEXTNEST_CAPTURE_MODE: "off" }, { CONTEXTNEST_AUTO_CAPTURE: "false" }]) {
      expect(captureGate({ input: {}, env, readTranscript: tx([]) })).toBeNull();
    }
  });

  it("allows on the stop_hook_active loop guard", () => {
    expect(
      captureGate({ input: { stop_hook_active: true }, env: {}, readTranscript: tx(["x"]) }),
    ).toBeNull();
  });

  it("an ordinary tool-using turn no longer gates — the noise fix", () => {
    // This is the exact input the old gate blocked on. Substantive alone is now
    // a necessary condition, not a sufficient one.
    const out = captureGate({
      input: { transcript_path: "t", session_id: "s1" },
      env: {},
      readTranscript: tx([userLine("run the tests"), '{"role":"assistant","content":[{"tool_use":1}]}']),
      ledgerIo: fakeLedgerIo(),
    });
    expect(out).toBeNull();
  });

  it("a whole short session of tool-using turns stays silent", () => {
    // The cooldown counts from session start, so nothing ambient fires until
    // the conversation has actually run on for a while.
    const io = fakeLedgerIo();
    const lines = [userLine("do a thing"), '{"role":"assistant","content":[{"tool_use":1}]}'];
    for (let turn = 1; turn <= 4; turn++) {
      expect(
        captureGate({
          input: { transcript_path: "t", session_id: "s1" },
          env: {},
          readTranscript: tx(lines, turn),
          ledgerIo: io,
        }),
        `turn ${turn}`,
      ).toBeNull();
    }
  });

  it("gates on explicit capture intent and names the capture agent", () => {
    const out = captureGate({
      input: { transcript_path: "t", session_id: "s1" },
      env: {},
      readTranscript: tx([userLine("remember that we use pnpm")]),
      ledgerIo: fakeLedgerIo(),
    });
    expect(out?.decision).toBe("block");
    expect(out?.reason).toMatch(/contextnest-capture/);
  });

  it("gates on a correction and routes to the curator, not the capture agent", () => {
    const out = captureGate({
      input: { transcript_path: "t", session_id: "s1" },
      env: {},
      readTranscript: tx([userLine("actually it's 30 seconds not 60")]),
      ledgerIo: fakeLedgerIo(),
    });
    expect(out?.decision).toBe("block");
    expect(out?.reason).toMatch(/contextnest-curator/);
    expect(out?.reason).toMatch(/EVERY node/);
  });

  it("a correction outranks a capture phrase in the same message", () => {
    const signal = captureSignal({
      transcript: { lines: [userLine("remember: actually it's Y not X")], userTurns: 1 },
      ledger: noLedger,
      env: {},
      captureMode: "propose",
    });
    expect(signal.kind).toBe("change");
  });

  it("propose mode tells the agent not to write; auto mode tells it to persist", () => {
    const t = { lines: [userLine("remember this")], userTurns: 1 };
    expect(
      captureSignal({ transcript: t, ledger: noLedger, env: {}, captureMode: "propose" }).reason,
    ).toMatch(/must NOT write/);
    expect(
      captureSignal({ transcript: t, ledger: noLedger, env: {}, captureMode: "auto" }).reason,
    ).toMatch(/persist/);
  });

  it("an ambient gate stamps the cooldown, and the next one is suppressed", () => {
    const io = fakeLedgerIo();
    const lines = [userLine("go on"), '{"role":"assistant","content":[{"tool_use":1}]}'];
    const input = { transcript_path: "t", session_id: "s1" };

    // Far enough past the default cooldown that the first ambient pass fires.
    const first = captureGate({
      input,
      env: { CONTEXTNEST_CAPTURE_MIN_TURNS: "5" },
      readTranscript: tx(lines, 20),
      ledgerIo: io,
    });
    expect(first?.decision).toBe("block");
    expect(loadLedger("s1", io).lastGatedTurn).toBe(20);

    // One turn later: still inside the window, so nothing fires.
    expect(
      captureGate({
        input,
        env: { CONTEXTNEST_CAPTURE_MIN_TURNS: "5" },
        readTranscript: tx(lines, 21),
        ledgerIo: io,
      }),
    ).toBeNull();
  });

  it("explicit intent bypasses the cooldown and does not restamp it", () => {
    const io = fakeLedgerIo();
    saveLedger("s1", { lastGatedTurn: 20, captured: [] }, io);
    const out = captureGate({
      input: { transcript_path: "t", session_id: "s1" },
      env: {},
      readTranscript: tx([userLine("remember that")], 21),
      ledgerIo: io,
    });
    expect(out?.decision).toBe("block");
    // Asking twice in a row must both land, so an explicit pass leaves the
    // window where it was rather than opening a new one.
    expect(loadLedger("s1", io).lastGatedTurn).toBe(20);
  });

  it("CONTEXTNEST_CAPTURE_ALWAYS forces a block past both the heuristic and the cooldown", () => {
    const io = fakeLedgerIo();
    saveLedger("s1", { lastGatedTurn: 20, captured: [] }, io);
    const out = captureGate({
      input: { transcript_path: "t", session_id: "s1" },
      env: { CONTEXTNEST_CAPTURE_ALWAYS: "1" },
      readTranscript: tx([userLine("hi")], 21),
      ledgerIo: io,
    });
    expect(out?.decision).toBe("block");
  });

  it("isSubstantive: tool use → true; an unreadable tail is no longer a reason to capture", () => {
    expect(isSubstantive(['{"role":"assistant","tool_use":1}'])).toBe(true);
    expect(isSubstantive([])).toBe(false);
    expect(isSubstantive(['{"role":"user"}', '{"role":"assistant"} short'])).toBe(false);
  });
});
