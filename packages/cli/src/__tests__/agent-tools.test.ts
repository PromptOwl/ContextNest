import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentTools, isOnPath, hasDirWithPrefix } from "../agent-tools.js";

// detectAgentTools reads os.homedir() (HOME on POSIX) and process.env.PATH.
// We point both at controlled temp dirs so detection is deterministic. We only
// assert on tools whose signals we fully control here — claude, gemini, copilot.
// cursor/windsurf also probe /Applications/*.app, which is machine-dependent.
describe("detectAgentTools", () => {
  let home: string;
  let project: string;
  let bin: string;
  let savedHome: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cn-home-"));
    project = mkdtempSync(join(tmpdir(), "cn-proj-"));
    bin = mkdtempSync(join(tmpdir(), "cn-bin-"));
    savedHome = process.env.HOME;
    savedPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = bin; // empty bin dir → nothing on PATH
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const find = (tools: ReturnType<typeof detectAgentTools>, id: string) =>
    tools.find((t) => t.id === id)!;

  it("returns the five supported tools, mapped to config-file hints", () => {
    const tools = detectAgentTools(project);
    expect(tools.map((t) => t.id)).toEqual([
      "claude",
      "cursor",
      "windsurf",
      "copilot",
      "gemini",
    ]);
    expect(find(tools, "claude").hint).toBe("CLAUDE.md");
    expect(find(tools, "gemini").hint).toBe("GEMINI.md");
  });

  it("does not detect claude/gemini/copilot with no markers present", () => {
    const tools = detectAgentTools(project);
    expect(find(tools, "claude").detected).toBe(false);
    expect(find(tools, "gemini").detected).toBe(false);
    expect(find(tools, "copilot").detected).toBe(false);
  });

  it("detects Claude Code via ~/.claude", () => {
    mkdirSync(join(home, ".claude"));
    expect(find(detectAgentTools(project), "claude").detected).toBe(true);
  });

  it("detects Claude Code via a project-local .claude directory", () => {
    mkdirSync(join(project, ".claude"));
    expect(find(detectAgentTools(project), "claude").detected).toBe(true);
  });

  it("detects Gemini CLI via a binary on PATH", () => {
    writeFileSync(join(bin, "gemini"), "#!/bin/sh\n", { mode: 0o755 });
    expect(find(detectAgentTools(project), "gemini").detected).toBe(true);
  });

  it("detects GitHub Copilot via a versioned VS Code extension folder", () => {
    mkdirSync(join(home, ".vscode", "extensions", "github.copilot-1.2.3"), {
      recursive: true,
    });
    expect(find(detectAgentTools(project), "copilot").detected).toBe(true);
  });
});

describe("isOnPath", () => {
  let bin: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "cn-bin-"));
    savedPath = process.env.PATH;
    process.env.PATH = bin;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it("finds a binary present on PATH", () => {
    writeFileSync(join(bin, "mytool"), "", { mode: 0o755 });
    expect(isOnPath("mytool")).toBe(true);
  });

  it("returns false for an absent binary", () => {
    expect(isOnPath("definitely-not-here")).toBe(false);
  });
});

describe("hasDirWithPrefix", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cn-ext-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches an entry by prefix", () => {
    mkdirSync(join(dir, "github.copilot-9.9.9"));
    expect(hasDirWithPrefix(dir, "github.copilot")).toBe(true);
  });

  it("returns false when no entry matches and on a missing directory", () => {
    expect(hasDirWithPrefix(dir, "github.copilot")).toBe(false);
    expect(hasDirWithPrefix(join(dir, "nope"), "x")).toBe(false);
  });
});
