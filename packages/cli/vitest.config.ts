import { defineConfig, configDefaults } from "vitest/config";

// Default unit run for this package. Regression suites (*.regression.test.ts)
// are excluded here — they spawn the built CLI (dist/index.js) and run via
// the dedicated `pnpm test:regression` (vitest.regression.config.ts) after a build.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.regression.test.ts"],
    // Many CLI tests spawn the compiled `node dist/index.js` as a subprocess.
    // Cold Node startup × several commands per test can blow past the 5s default
    // when the whole workspace runs in parallel; give them headroom to avoid
    // load-dependent flakes (the regression config uses 30s for the same reason).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
