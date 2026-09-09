import { defineConfig, configDefaults } from "vitest/config";

// Default unit run for this package. Regression suites (*.regression.test.ts)
// are excluded here — they spawn the built server and run via the dedicated
// `pnpm test:regression` (vitest.regression.config.ts) after a build.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.regression.test.ts"],
  },
});
