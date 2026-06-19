import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each package is its own project. Replaces the removed
    // vitest.workspace.ts (Vitest 4 uses test.projects instead).
    projects: ["packages/*"],
  },
});
