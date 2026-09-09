import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    // Integrity and history suites fsync every write (durable hash chains), and
    // fsync is slow on the Windows CI runners — slow enough to blow past the 5s
    // default when the whole workspace runs in parallel, which surfaced as
    // timeouts plus ENOTEMPTY as cleanup raced the still-running test. Same
    // headroom the CLI config already carries for the same reason.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
