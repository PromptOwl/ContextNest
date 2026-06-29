import { defineConfig } from "vitest/config";

// Standalone config for the regression suites. Run via `pnpm test:regression`,
// which builds the MCP server first so the spawned dist/index.js is current.
// Kept separate from the default `pnpm test` (which excludes *.regression.test.ts)
// so e2e results are reported on their own and gated behind a build.
export default defineConfig({
  test: {
    include: ["packages/**/*.regression.test.ts"],
    // Spawning a child server/CLI + handshake is slower than a unit test, and
    // notably slower on the Windows CI runners (process startup cost). Generous
    // timeouts keep these subprocess-heavy e2e suites from flaking under load.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
