/**
 * chalk is an optionalDependency, and DEPENDENCIES.md promises that
 * `npm i -g @promptowl/contextnest-cli --omit=optional` still runs every
 * command, just without colour. tsup marks chalk external, so a static
 * `import chalk from "chalk"` in any bundled module throws
 * ERR_MODULE_NOT_FOUND at load time on that install — losing the whole CLI,
 * not just the colour. Every call site goes through ./color.js, which falls
 * back to a plain-text proxy when the package is absent.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("chalk stays optional", () => {
  it("no module imports chalk directly — colour goes through ./color.js", () => {
    // The type-only import in color.ts is erased at build time, so it is fine.
    const direct = /^import\s+(?!type\b)[^;]*from\s+"chalk"/m;
    const offenders = sourceFiles(srcDir)
      .filter((file) => direct.test(readFileSync(file, "utf-8")))
      .map((file) => relative(srcDir, file));
    expect(offenders).toEqual([]);
  });
});
