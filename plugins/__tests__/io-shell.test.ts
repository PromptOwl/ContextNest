/**
 * IO-shell tests — spawn the real core scripts as `node <script>` with piped
 * stdin and assert stdout + exit code. These exercise the stdin→run→stdout→exit
 * wiring on paths that do NOT need a real ctx (off / agent / capture gate), so
 * they run in the default suite and stay cross-platform.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = (name: string) => join(here, "..", "shared", "core", name);

/** Run a core script with a JSON stdin payload + env; return {status, stdout}. */
function runScript(
  script: string,
  input: unknown,
  env: Record<string, string> = {},
): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      env: { ...process.env, ...env },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ? String(err.stdout) : "" };
  }
}

describe("retrieve.js IO shell", () => {
  it("off mode → exit 0, no output", () => {
    const r = runScript(core("retrieve.js"), { prompt: "auth" }, { CONTEXTNEST_RETRIEVAL_MODE: "off" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("agent mode → exit 0, prints UserPromptSubmit additionalContext", () => {
    const r = runScript(core("retrieve.js"), { prompt: "x" }, { CONTEXTNEST_RETRIEVAL_MODE: "agent" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/contextnest-retriever/);
  });
});

describe("capture-gate.js IO shell", () => {
  const userLine = (text: string) =>
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  const TOOL_TURN = '{"role":"assistant","content":[{"type":"tool_use"}]}';

  /** Write a transcript into a throwaway dir and hand it to `fn`. */
  function withTranscript(lines: string[], fn: (path: string, home: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "cn-io-"));
    const tpath = join(dir, "transcript.jsonl");
    writeFileSync(tpath, lines.join("\n"));
    try {
      fn(tpath, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("loop guard → exit 0, no output", () => {
    const r = runScript(core("capture-gate.js"), { stop_hook_active: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("an ordinary tool-using turn is silent once the session is in cooldown", () => {
    withTranscript([userLine("run the tests"), TOOL_TURN], (tpath, home) => {
      mkdirSync(join(home, ".contextnest", "plugin-state"), { recursive: true });
      // One user turn in the transcript, stamped as just gated → inside the window.
      writeFileSync(
        join(home, ".contextnest", "plugin-state", "sess1.json"),
        JSON.stringify({ lastGatedTurn: 1, captured: [] }),
      );
      const r = runScript(
        core("capture-gate.js"),
        { transcript_path: tpath, session_id: "sess1" },
        // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows.
        { HOME: home, USERPROFILE: home },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });
  });

  it("explicit capture intent → Stop block naming the capture agent", () => {
    withTranscript([userLine("remember that we use pnpm")], (tpath) => {
      const r = runScript(core("capture-gate.js"), { transcript_path: tpath });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toMatch(/contextnest-capture/);
    });
  });

  it("a correction → Stop block naming the curator instead", () => {
    withTranscript([userLine("actually it's 30 seconds not 60")], (tpath) => {
      const r = runScript(core("capture-gate.js"), { transcript_path: tpath });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toMatch(/contextnest-curator/);
    });
  });

  it("capture_mode=off and the legacy auto_capture=false both stay silent", () => {
    for (const env of [{ CONTEXTNEST_CAPTURE_MODE: "off" }, { CONTEXTNEST_AUTO_CAPTURE: "false" }]) {
      const r = runScript(core("capture-gate.js"), { transcript_path: "x" }, env);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    }
  });
});
