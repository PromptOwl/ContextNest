import { describe, it, expect } from "vitest";
import {
  DEFAULT_SERVER,
  isBareInvocation,
  isHeadless,
  runOnboarding,
  shouldOnboard,
  type OnboardingDeps,
  type OnboardingState,
} from "../first-run.js";

const base = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  argv: ["node", "ctx"],
  env: {},
  tty: true,
  registry: { vaults: {} },
  vaultResolves: false,
  ...over,
});

describe("shouldOnboard", () => {
  it("onboards a bare first run on a terminal", () => {
    expect(shouldOnboard(base())).toEqual({ action: "onboard" });
  });
  it("never onboards when a subcommand or flag is given", () => {
    expect(shouldOnboard(base({ argv: ["node", "ctx", "list"] })).action).toBe("help");
    expect(isBareInvocation(["node", "ctx", "--help"])).toBe(false);
  });
  it("silently marks existing users (vault, remote, env, or local .context) as onboarded", () => {
    for (const s of [
      base({ registry: { vaults: { a: {} } } }),
      base({ registry: { vaults: {}, remotes: { r: {} } } }),
      base({ vaultResolves: true }),
      base({ env: { CONTEXTNEST_VAULT_PATH: "/x" } }),
    ]) {
      expect(shouldOnboard(s)).toEqual({ action: "help", markOnboarded: true });
    }
  });
  it("does not re-mark or re-onboard once a marker exists, even with all vaults deleted", () => {
    expect(shouldOnboard(base({ registry: { vaults: {}, onboarded_at: "t" } }))).toEqual({
      action: "help",
      markOnboarded: false,
    });
    expect(shouldOnboard(base({ registry: { vaults: {}, skipped_at: "t" } })).action).toBe("help");
    expect(shouldOnboard(base({ registry: { vaults: { a: {} }, onboarded_at: "t" } }))).toEqual({
      action: "help",
      markOnboarded: false,
    });
  });
  it("never prompts in CI or without a terminal; non-TTY gets a hint", () => {
    const ci = shouldOnboard(base({ env: { CI: "1" } }));
    expect(ci.action).toBe("help");
    const piped = shouldOnboard(base({ tty: false }));
    expect(piped).toMatchObject({ action: "help", markOnboarded: false });
    expect((piped as { hint?: string }).hint).toMatch(/terminal/);
  });
});

describe("isHeadless", () => {
  it("detects ssh and display-less linux only", () => {
    expect(isHeadless({ SSH_CONNECTION: "1" }, "darwin")).toBe(true);
    expect(isHeadless({}, "linux")).toBe(true);
    expect(isHeadless({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isHeadless({}, "darwin")).toBe(false);
  });
});

function makeDeps(answers: string[], over: Partial<OnboardingDeps> = {}) {
  const calls: string[][] = [];
  const marks: string[] = [];
  const lines: string[] = [];
  const queue = [...answers];
  const deps: OnboardingDeps = {
    env: { NO_COLOR: "1" },
    home: "/h",
    ask: async (_q, d) => queue.shift() ?? d,
    run: async (args) => {
      calls.push(args);
    },
    log: (l) => lines.push(l),
    exists: () => false,
    joinPath: (...p) => p.join("/"),
    markOnboarding: (k) => marks.push(k),
    detectedTools: () => ["claude"],
    signedIn: async () => false,
    ...over,
  };
  return { deps, calls, marks, lines };
}

describe("runOnboarding", () => {
  it("local default: runs init with defaults, marks onboarded", async () => {
    const { deps, calls, marks } = makeDeps([]);
    expect(await runOnboarding(deps)).toBe("onboarded");
    expect(calls[0]).toEqual([
      "--yes", "--vault", "main", "init", "--starter", "developer", "--name", "main", "--set-default", "--tools", "claude",
    ]);
    expect(marks).toEqual(["onboarded"]);
  });
  it("skip records skipped and shows the three commands", async () => {
    const { deps, calls, marks, lines } = makeDeps(["4"]);
    expect(await runOnboarding(deps)).toBe("skipped");
    expect(calls).toEqual([]);
    expect(marks).toEqual(["skipped"]);
    expect(lines.join("\n")).toMatch(/ctx init[\s\S]*ctx login[\s\S]*ctx vault add/);
  });
  it("remote: logs in to the default server and registers it", async () => {
    const { deps, calls, marks } = makeDeps(["2"]);
    expect(await runOnboarding(deps)).toBe("onboarded");
    expect(calls[0]).toEqual(["--yes", "login", DEFAULT_SERVER, "--as", "promptowl", "--set-default"]);
    expect(marks).toEqual(["onboarded"]);
  });
  it("remote: already signed in skips login and just registers the server", async () => {
    const { deps, calls } = makeDeps(["2"], { signedIn: async () => true });
    expect(await runOnboarding(deps)).toBe("onboarded");
    expect(calls[0]).toEqual(["vault", "add", "promptowl", "--url", `${DEFAULT_SERVER}/mcp`, "--set-default"]);
    expect(calls.some((c) => c.includes("login"))).toBe(false);
  });
  it("finishes by listing the default vault", async () => {
    const { deps, calls } = makeDeps([]);
    await runOnboarding(deps);
    expect(calls.map((c) => c[0])).toContain("list");
  });
  it("both: a failed remote half keeps the local vault and still marks onboarded", async () => {
    const { deps, marks, lines } = makeDeps(["3"], {
      run: async (args) => {
        if (args.includes("login")) throw new Error("denied");
      },
    });
    expect(await runOnboarding(deps)).toBe("onboarded");
    expect(marks).toEqual(["onboarded"]);
    expect(lines.join("\n")).toMatch(/Nothing was changed on your account/);
  });
  it("both: the server is the default only when the local half failed", async () => {
    const ok = makeDeps(["3"]);
    await runOnboarding(ok.deps);
    expect(ok.calls.find((c) => c.includes("login"))).not.toContain("--set-default");

    const localFails = makeDeps(["3"], {
      run: async (args) => {
        localFails.calls.push(args);
        if (args.includes("init")) throw new Error("boom");
      },
    });
    expect(await runOnboarding(localFails.deps)).toBe("onboarded");
    expect(localFails.calls.find((c) => c.includes("login"))).toContain("--set-default");
    expect(localFails.lines.join("\n")).not.toMatch(/Your agent is ready/);
  });
  it("claims agent config only when init wrote some", async () => {
    const withTools = makeDeps([]);
    await runOnboarding(withTools.deps);
    expect(withTools.lines.join("\n")).toMatch(/Your agent is ready/);

    const noTools = makeDeps([], { detectedTools: () => [] });
    await runOnboarding(noTools.deps);
    expect(noTools.calls[0]).toContain("none");
    expect(noTools.lines.join("\n")).not.toMatch(/Your agent is ready/);
  });
  it("an unknown choice sets nothing up", async () => {
    const { deps, calls, marks } = makeDeps(["7"]);
    expect(await runOnboarding(deps)).toBe("failed");
    expect(calls).toEqual([]);
    expect(marks).toEqual([]);
  });
  it("remote-only failure marks nothing, so the next `ctx` retries", async () => {
    const { deps, marks } = makeDeps(["2"], {
      run: async () => {
        throw new Error("timeout");
      },
    });
    expect(await runOnboarding(deps)).toBe("failed");
    expect(marks).toEqual([]);
  });
  it("declining the local confirm sets nothing up", async () => {
    const { deps, calls, marks } = makeDeps(["1", "n"]);
    expect(await runOnboarding(deps)).toBe("failed");
    expect(calls).toEqual([]);
    expect(marks).toEqual([]);
  });
  it("refuses to overwrite an existing vault dir", async () => {
    const { deps, calls } = makeDeps([], { exists: () => true });
    expect(await runOnboarding(deps)).toBe("failed");
    expect(calls).toEqual([]);
  });
  it("customize asks for starter, name and folder", async () => {
    const cwds: (string | undefined)[] = [];
    const { deps, calls } = makeDeps(["1", "c", "team", "work", "/x/work"], {
      run: async (args, cwd) => {
        calls.push(args);
        cwds.push(cwd);
      },
    });
    await runOnboarding(deps);
    expect(calls[0]).toEqual([
      "--yes", "--vault", "work", "init", "--starter", "team", "--name", "work", "--set-default", "--tools", "claude",
    ]);
    expect(cwds[0]).toBe("/x/work");
  });
  it("customize still refuses a folder that already holds a vault", async () => {
    const { deps, calls } = makeDeps(["1", "c", "team", "work", "/x/work"], {
      exists: (p) => p === "/x/work/.context/config.yaml",
    });
    expect(await runOnboarding(deps)).toBe("failed");
    expect(calls).toEqual([]);
  });
});
