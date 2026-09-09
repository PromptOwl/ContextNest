/**
 * Unit tests for the MCP server's vault resolution wrapper.
 *
 * resolveMcpVaultPath is a thin adapter over the engine's resolveVaultPath: it
 * threads the positional arg through, surfaces a non-fatal advisory on stderr,
 * and lets a hard error (typo / unknown alias) propagate so the bootstrap can
 * exit non-zero. These tests pin that contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMcpVaultPath } from "../vault-resolution.js";

/** Create a directory that looks like a vault (has .context/config.yaml). */
function makeVault(root: string): string {
  mkdirSync(join(root, ".context"), { recursive: true });
  writeFileSync(join(root, ".context", "config.yaml"), `version: 1\nname: "MCP Vault"\n`);
  return root;
}

describe("resolveMcpVaultPath", () => {
  let tmp: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-mcp-"));
    savedEnv = {
      CONTEXTNEST_CONFIG_DIR: process.env.CONTEXTNEST_CONFIG_DIR,
      CONTEXTNEST_VAULT: process.env.CONTEXTNEST_VAULT,
      CONTEXTNEST_VAULT_PATH: process.env.CONTEXTNEST_VAULT_PATH,
    };
    process.env.CONTEXTNEST_CONFIG_DIR = join(tmp, "cfg");
    delete process.env.CONTEXTNEST_VAULT;
    delete process.env.CONTEXTNEST_VAULT_PATH;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves an absolute vault path passed as the positional arg", () => {
    const v = makeVault(join(tmp, "v"));
    expect(resolveMcpVaultPath(v)).toBe(v);
  });

  it("throws on a typo arg (neither a registered alias nor an absolute path)", () => {
    // The bootstrap relies on this throwing so it can exit non-zero rather than
    // silently serving a bogus relative path.
    expect(() => resolveMcpVaultPath("mytypo")).toThrow(/not a registered vault alias/);
  });

  it("writes the resolver's advisory to stderr and still returns a path", () => {
    // A stale absolute path is non-fatal: it warns and falls through to the cwd
    // fallback. The advisory must reach the user on stderr.
    const stale = join(tmp, "not-a-vault");
    mkdirSync(stale, { recursive: true });
    const cwd = process.cwd();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });

    process.env.CONTEXTNEST_VAULT_PATH = stale;
    const result = resolveMcpVaultPath(undefined);

    expect(result).toBe(cwd); // fell through to cwd
    expect(spy).toHaveBeenCalled();
    expect(writes.join("")).toContain("contextnest-mcp:");
    expect(writes.join("")).toMatch(/CONTEXTNEST_VAULT_PATH/);
  });

  it("does not write to stderr when resolution is clean", () => {
    const v = makeVault(join(tmp, "clean"));
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    resolveMcpVaultPath(v);
    expect(spy).not.toHaveBeenCalled();
  });
});
