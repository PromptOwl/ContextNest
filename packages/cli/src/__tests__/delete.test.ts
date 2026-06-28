/**
 * Regression tests for Bug 3: `ctx delete <path>` crashed Node with an
 * unhandled promise rejection when the document did not exist.
 *
 * Root cause: `program.parse()` (not `parseAsync()`) didn't await async action
 * callbacks, so `DocumentNotFoundError` was never caught and crashed Node.
 *
 * Fix: `program.parseAsync().catch(...)` + per-action try/catch in delete.
 * These tests FAIL before the fix and pass after.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const BASE_ENV = { CONTEXTNEST_NO_BROWSER: "1" };

function runCtx(args: string[], cwd: string) {
  return spawnSync("node", [distPath, ...args], {
    cwd,
    env: { ...process.env, ...BASE_ENV },
    encoding: "utf8",
  });
}

function runCtxOrThrow(args: string[], cwd: string): void {
  execFileSync("node", [distPath, ...args], {
    cwd,
    env: { ...process.env, ...BASE_ENV },
    stdio: "ignore",
  });
}

describe("ctx delete — Bug 3 regression: crash on missing node", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "cn-delete-"));
    runCtxOrThrow(
      ["init", "--name", "delete-test-vault", "--layout", "flat"],
      vault,
    );
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("exits 1 with a clean error message when the node does not exist (no crash)", () => {
    const result = runCtx(["delete", "nodes/ghost"], vault);

    // Before fix: DocumentNotFoundError became an unhandled promise rejection
    // because program.parse() discarded the Promise returned by the async
    // action. Node crashed with an UnhandledPromiseRejection and a stack trace.
    //
    // After fix: clean chalk.red message on stderr, exit code 1, no stack trace.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not delete nodes/ghost");
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
    expect(result.stderr).not.toMatch(/\s+at\s+/); // no stack frames
  });

  it("exits 0 and prints the deleted document title on a successful delete", () => {
    runCtxOrThrow(["add", "nodes/testnode", "--title", "Test Node"], vault);

    const result = runCtx(["delete", "nodes/testnode"], vault);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Deleted nodes/testnode");
    expect(result.stdout).toContain("Test Node");
  });

  it("exits 1 cleanly when deleting an already-deleted node (double-delete, no crash)", () => {
    runCtxOrThrow(["add", "nodes/testnode", "--title", "Test Node"], vault);
    runCtxOrThrow(["delete", "nodes/testnode"], vault);

    // Second delete must not crash, just report the error cleanly.
    const result = runCtx(["delete", "nodes/testnode"], vault);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not delete nodes/testnode");
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
    expect(result.stderr).not.toMatch(/\s+at\s+/);
  });
});
