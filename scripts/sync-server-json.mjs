#!/usr/bin/env node
// Keeps server.json on the version `changeset version` just gave the MCP server
// package. The official MCP Registry rejects a server.json whose version does
// not exist on npm, and changesets knows nothing about this file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function syncServerJson(server, packageName, version) {
  return {
    ...server,
    version,
    packages: server.packages.map((entry) =>
      entry.registryType === "npm" && entry.identifier === packageName
        ? { ...entry, version }
        : entry,
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const serverPath = resolve(root, "server.json");
  const pkg = JSON.parse(readFileSync(resolve(root, "packages/mcp-server/package.json"), "utf8"));
  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  const synced = syncServerJson(server, pkg.name, pkg.version);
  writeFileSync(serverPath, `${JSON.stringify(synced, null, 2)}\n`);
}
