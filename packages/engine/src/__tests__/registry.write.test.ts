/**
 * writeRegistry internals: the atomic rename and its Windows-only copy fallback.
 *
 * These live in their own file because they mock `node:fs.renameSync`. Isolating
 * the mock here keeps it from leaking into registry.test.ts, which relies on a
 * fully real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Toggleable rename/copy behavior, hoisted so the vi.mock factory can close over it.
const state = vi.hoisted(() => ({
  renameImpl: undefined as undefined | ((from: string, to: string) => void),
  copyImpl: undefined as undefined | ((from: string, to: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = (from: string, to: string) =>
    (state.renameImpl ?? actual.renameSync)(from, to);
  const copyFileSync = (from: string, to: string) =>
    (state.copyImpl ?? actual.copyFileSync)(from, to);
  return { ...actual, default: { ...actual, renameSync, copyFileSync }, renameSync, copyFileSync };
});

// Imported AFTER the mock is registered so registry.ts binds the wrapped rename.
const { writeRegistry, getRegistryDir, getRegistryPath } = await import("../registry.js");
const { ConfigError } = await import("../errors.js");

function eperm(): never {
  const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
  e.code = "EPERM";
  throw e;
}

describe("writeRegistry atomic write + Windows fallback", () => {
  let tmp: string;
  let savedConfigDir: string | undefined;
  let savedPlatform: PropertyDescriptor;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-reg-write-"));
    savedConfigDir = process.env.CONTEXTNEST_CONFIG_DIR;
    process.env.CONTEXTNEST_CONFIG_DIR = join(tmp, "cfg");
    savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  });

  afterEach(() => {
    state.renameImpl = undefined;
    state.copyImpl = undefined;
    Object.defineProperty(process, "platform", savedPlatform);
    if (savedConfigDir === undefined) delete process.env.CONTEXTNEST_CONFIG_DIR;
    else process.env.CONTEXTNEST_CONFIG_DIR = savedConfigDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { value: p, configurable: true });

  it("writes via rename on the happy path, leaving no temp file", () => {
    writeRegistry({ version: 1, default: "a", vaults: { a: { path: "/v/a" } } });
    const dir = getRegistryDir();
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
    expect(readFileSync(getRegistryPath(), "utf-8")).toContain("path: /v/a");
  });

  it("falls back to copyFileSync when rename hits EPERM on Windows", () => {
    setPlatform("win32");
    state.renameImpl = eperm;

    writeRegistry({ version: 1, vaults: { w: { path: "/v/w" } } });

    // The copy fallback produced the target...
    expect(readFileSync(getRegistryPath(), "utf-8")).toContain("path: /v/w");
    // ...and the temp file was still cleaned up in the finally block.
    expect(readdirSync(getRegistryDir()).some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("does NOT fall back on a non-EPERM rename error, even on Windows", () => {
    setPlatform("win32");
    state.renameImpl = () => {
      const e = new Error("EBUSY") as NodeJS.ErrnoException;
      e.code = "EBUSY";
      throw e;
    };

    expect(() => writeRegistry({ version: 1, vaults: {} })).toThrow(/EBUSY/);
    // No partial config.yaml, and the temp file was cleaned up.
    const entries = readdirSync(getRegistryDir());
    expect(entries).not.toContain("config.yaml");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("does NOT fall back on EPERM on non-Windows platforms — it surfaces the error", () => {
    setPlatform("linux");
    state.renameImpl = eperm;

    expect(() => writeRegistry({ version: 1, vaults: {} })).toThrow(/EPERM/);
    const entries = readdirSync(getRegistryDir());
    expect(entries).not.toContain("config.yaml");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("wraps a failed copy fallback in a ConfigError naming the target", () => {
    setPlatform("win32");
    state.renameImpl = eperm; // forces the copy fallback...
    state.copyImpl = () => {
      throw new Error("disk full");
    }; // ...which then fails too.

    let caught: unknown;
    try {
      writeRegistry({ version: 1, vaults: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain(getRegistryPath());
    expect((caught as Error).message).toContain("disk full");
    // Temp file still cleaned up even when both rename and copy fail.
    expect(readdirSync(getRegistryDir()).some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
