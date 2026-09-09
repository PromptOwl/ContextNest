import { defineConfig, configDefaults } from "vitest/config";

// Default unit + structural run for the plugins workspace. The integration
// suite (*.regression.test.ts) is excluded here — it spawns the built CLI
// (packages/cli/dist/index.js) against throwaway vaults and runs via the
// dedicated `pnpm test:regression` after a build.
export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.regression.test.ts"],
    // Some structural/IO-shell tests spawn `node <script>`; cold Node startup
    // under parallel load can exceed the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
