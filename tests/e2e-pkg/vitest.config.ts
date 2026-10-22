import { defineConfig } from "vitest/config";

// QA-owned release-gate suite (packaging & install integrity). Kept separate
// from the dev-owned regression config on purpose: it packs and installs the
// real tarball, so it is slow, needs network + npm, and is gated to release
// PRs / pre-publish rather than every push. Run via `pnpm test:pkg`.
export default defineConfig({
  test: {
    include: ["tests/e2e-pkg/**/*.pkg.test.ts"],
    // npm pack + multiple clean installs dominate wall-clock, and process
    // startup is slowest on the Windows runners.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
  },
});
