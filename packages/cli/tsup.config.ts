import { defineConfig } from "tsup";
import { createRequire } from "node:module";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  noExternal: ["@promptowl/contextnest-engine"],
  // chalk lives in optionalDependencies, which tsup does not auto-externalize.
  // Bundling it would defeat the point: `--omit=optional` must actually drop
  // the code, with src/color.ts falling back to plain output.
  external: ["chalk"],
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);`,
  },
});
