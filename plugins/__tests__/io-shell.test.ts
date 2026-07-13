/**
 * IO-shell tests — spawn the real core scripts as `node <script>` with piped
 * stdin and assert stdout + exit code. These exercise the stdin→run→stdout→exit
 * wiring on paths that do NOT need a real ctx (off / agent / capture gate), so
 * they run in the default suite and stay cross-platform.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  it("loop guard → exit 0, no output", () => {
    const r = runScript(core("capture-gate.js"), { stop_hook_active: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("substantive transcript → prints a Stop block decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "cn-io-"));
    const tpath = join(dir, "transcript.jsonl");
    writeFileSync(
      tpath,
      ['{"role":"user","content":"hi"}', '{"role":"assistant","content":[{"type":"tool_use"}]}'].join("\n"),
    );
    try {
      const r = runScript(core("capture-gate.js"), { transcript_path: tpath });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toMatch(/contextnest-capture/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto_capture=false → exit 0, no output", () => {
    const r = runScript(core("capture-gate.js"), { transcript_path: "x" }, { CONTEXTNEST_AUTO_CAPTURE: "false" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
