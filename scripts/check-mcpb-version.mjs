#!/usr/bin/env node
/**
 * Fails if mcpb/manifest.json's version has drifted from the mcp-server package
 * it vendors. The bundle installs `@promptowl/contextnest-mcp-server@<version>`
 * from npm, so a stale manifest ships a bundle whose advertised version is not
 * the code inside it — invisible until someone reports a bug against the wrong
 * version.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

const manifest = read("mcpb/manifest.json").version;
const pkg = read("packages/mcp-server/package.json").version;

if (manifest !== pkg) {
  console.error(
    `mcpb/manifest.json version "${manifest}" != packages/mcp-server "${pkg}".\n` +
      `Bump both together, then rebuild the bundle (see mcpb/README.md).`,
  );
  process.exit(1);
}

console.log(`mcpb/manifest.json version in sync with mcp-server (${pkg})`);
