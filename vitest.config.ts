import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each package is its own project. Replaces the removed
    // vitest.workspace.ts (Vitest 4 uses test.projects instead).
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      // Build artifacts get instrumented when regression tests invoke the
      // bundled CLI/engine output — exclude them so coverage reflects source.
      exclude: ["**/dist/**", "**/__tests__/**", "**/*.config.ts"],
    },
  },
});
