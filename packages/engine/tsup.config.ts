import { defineConfig } from "tsup";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/api/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // Bake the version into the bundle: the CLI inlines this package, so at
  // runtime there is no engine package.json to read (see src/version.ts).
  define: { __ENGINE_VERSION__: JSON.stringify(pkg.version) },
});
