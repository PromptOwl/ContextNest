import { defineConfig, configDefaults } from "vitest/config";

// Default unit run for this package. Regression suites (*.regression.test.ts)
// spawn the built CLI + this package's dist and run via the dedicated
// `pnpm test:regression` (vitest.regression.config.ts) after a build.
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.regression.test.ts"],
  },
});
