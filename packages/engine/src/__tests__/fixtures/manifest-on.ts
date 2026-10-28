import { afterAll, beforeAll } from "vitest";

/**
 * Run the enclosing suite with the manifest switched on. It is a POC behind
 * `CONTEXTNEST_MANIFEST` (manifest.ts `manifestEnabled`) and off by default.
 */
export function useManifest(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.CONTEXTNEST_MANIFEST;
    process.env.CONTEXTNEST_MANIFEST = "on";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CONTEXTNEST_MANIFEST;
    else process.env.CONTEXTNEST_MANIFEST = previous;
  });
}
