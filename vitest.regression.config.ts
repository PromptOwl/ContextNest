import { defineConfig } from "vitest/config";

// Standalone config for the regression suites. Run via `pnpm test:regression`,
// which builds the MCP server first so the spawned dist/index.js is current.
// Kept separate from the default `pnpm test` (which excludes *.regression.test.ts)
// so e2e results are reported on their own and gated behind a build.
export default defineConfig({
  test: {
    include: ["packages/**/*.regression.test.ts"],
    // Spawning a child server + MCP handshake is slower than a unit test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
