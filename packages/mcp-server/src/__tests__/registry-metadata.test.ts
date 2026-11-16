import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { syncServerJson } from "../../../../scripts/sync-server-json.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));

describe("official MCP Registry metadata", () => {
  const server = readJson("server.json");
  const pkg = readJson("packages/mcp-server/package.json");
  const npmEntry = server.packages.find((p: { registryType: string }) => p.registryType === "npm");

  it("given the npm package, when the registry checks ownership, then mcpName matches server.json", () => {
    expect(pkg.mcpName).toBe(server.name);
  });

  it("given a release, when server.json is published, then it names the package and version on npm", () => {
    expect(npmEntry.identifier).toBe(pkg.name);
    expect(npmEntry.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  it("given the registry's limit, when the listing is read, then the description is at most 100 characters", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("given a hosted user, when they read the listing, then it offers the hosted endpoint over streamable HTTP", () => {
    expect(server.remotes).toContainEqual({
      type: "streamable-http",
      url: "https://nest.promptowl.ai/mcp",
    });
  });

  it("given the server finds a vault without it, when listed, then the vault path is not marked required", () => {
    const vaultPath = npmEntry.environmentVariables.find(
      (v: { name: string }) => v.name === "CONTEXTNEST_VAULT_PATH",
    );
    expect(vaultPath.isRequired).toBe(false);
  });
});

describe("syncServerJson", () => {
  it("given changeset bumped the package, when synced, then both versions follow and other packages do not", () => {
    const before = {
      version: "1.0.0",
      packages: [
        { registryType: "npm", identifier: "@promptowl/contextnest-mcp-server", version: "1.0.0" },
        { registryType: "oci", identifier: "other", version: "9.9.9" },
      ],
    };
    const after = syncServerJson(before, "@promptowl/contextnest-mcp-server", "1.0.1");
    expect(after.version).toBe("1.0.1");
    expect(after.packages[0].version).toBe("1.0.1");
    expect(after.packages[1].version).toBe("9.9.9");
  });
});
