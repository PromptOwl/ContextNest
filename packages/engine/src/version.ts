/**
 * The engine's own version, for `ctx doctor` and any other consumer that has
 * to report what it is running.
 *
 * The CLI bundles the engine (tsup `noExternal`), so at runtime there is no
 * `@promptowl/contextnest-engine/package.json` to look up and `import.meta.url`
 * points at the CLI's own dist. Reading a package.json relative to the current
 * file would therefore silently report the *CLI's* version from inside the CLI.
 * The build injects the literal instead (`define` in tsup.config.ts); the
 * package.json fallback only serves source runs (vitest, ts-node).
 *
 * The baked value reaches the CLI through the engine's dist, so the engine
 * must build before the CLI — `pnpm -r build` runs in topological order.
 */

import { createRequire } from "node:module";

declare const __ENGINE_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __ENGINE_VERSION__ === "string" && __ENGINE_VERSION__) return __ENGINE_VERSION__;
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "unknown";
}

export const ENGINE_VERSION: string = readVersion();
