import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // The server is a binary, not a library, so its dependencies are inlined at
  // build time and declared as devDependencies. Installing it therefore pulls
  // nothing transitive. See DEPENDENCIES.md for what ends up in the bundle.
  //
  // The MCP SDK matters most here: it declares express, hono, ajv and jose for
  // its HTTP and OAuth transports, none of which this stdio-only server touches.
  // Bundling lets tree-shaking drop that code instead of installing it.
  noExternal: [
    "@modelcontextprotocol/sdk",
    "@promptowl/contextnest-engine",
    "zod",
  ],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
