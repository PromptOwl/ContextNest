/**
 * The CLI's own version, read from package.json at runtime.
 *
 * One source of truth for every place that reports a version (telemetry
 * payloads, the welcome page, `ctx doctor`). Telemetry used to hard-code
 * "0.3.0" and reported that for every release since.
 *
 * `../package.json` resolves correctly from both layouts this module runs in:
 * `src/version.ts` under vitest and the bundled `dist/index.js` (tsup inlines
 * this module, so `import.meta.url` is the bundle's).
 */

import { createRequire } from "node:module";

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { name?: string; version?: string };
    if (pkg.name === "@promptowl/contextnest-cli" && typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through
  }
  return "unknown";
}

export const CLI_VERSION: string = readVersion();
