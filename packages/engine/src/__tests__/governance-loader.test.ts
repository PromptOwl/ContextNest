/**
 * Dynamic governance module loader — how a proprietary RBAC implementation
 * gets injected into CLI/MCP deployments without the AGPL engine referencing
 * it. Resolution precedence: explicit option → CONTEXTNEST_GOVERNANCE_MODULE
 * env → NestConfig.governance.module → null.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadGovernanceBundle } from "../governance-loader.js";
import { ConfigError } from "../errors.js";

let dir: string;

const DENY_ALL_MODULE = `
export default function createGovernance() {
  return {
    hooks: {
      isCzar: () => false,
      canIngest: () => false,
      isDocOwner: () => false,
      canRead: () => false,
      canCommit: () => false,
    },
  };
}
`;

const ALLOW_READ_MODULE = `
export function createGovernance(ctx) {
  return {
    hooks: {
      isCzar: () => false,
      canIngest: () => true,
      isDocOwner: () => false,
      canRead: () => true,
      canCommit: () => false,
    },
    recorder: { record: () => {} },
  };
}
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "contextnest-gov-loader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadGovernanceBundle", () => {
  it("returns null when nothing is configured (caller falls back to permissive default)", async () => {
    const bundle = await loadGovernanceBundle({ vaultPath: dir, env: {} });
    expect(bundle).toBeNull();
  });

  it("loads a module from an explicit path (default-export factory)", async () => {
    const modPath = join(dir, "deny-all.mjs");
    await writeFile(modPath, DENY_ALL_MODULE, "utf-8");

    const bundle = await loadGovernanceBundle({ module: modPath, env: {} });
    expect(bundle).not.toBeNull();
    expect(await bundle!.hooks!.canRead!("anyone", { documentId: "nodes/x" })).toBe(false);
  });

  it("loads a module via CONTEXTNEST_GOVERNANCE_MODULE env (named-export factory)", async () => {
    const modPath = join(dir, "allow-read.mjs");
    await writeFile(modPath, ALLOW_READ_MODULE, "utf-8");

    const bundle = await loadGovernanceBundle({
      env: { CONTEXTNEST_GOVERNANCE_MODULE: modPath },
    });
    expect(await bundle!.hooks!.canRead!("anyone", { documentId: "nodes/x" })).toBe(true);
    expect(bundle!.recorder).toBeDefined();
  });

  it("explicit option wins over env", async () => {
    const denyPath = join(dir, "deny-all.mjs");
    const allowPath = join(dir, "allow-read.mjs");
    await writeFile(denyPath, DENY_ALL_MODULE, "utf-8");
    await writeFile(allowPath, ALLOW_READ_MODULE, "utf-8");

    const bundle = await loadGovernanceBundle({
      module: denyPath,
      env: { CONTEXTNEST_GOVERNANCE_MODULE: allowPath },
    });
    expect(await bundle!.hooks!.canRead!("anyone", { documentId: "nodes/x" })).toBe(false);
  });

  it("falls back to NestConfig governance.module, resolved relative to the vault", async () => {
    await mkdir(join(dir, ".context"), { recursive: true });
    await writeFile(join(dir, "vault-gov.mjs"), DENY_ALL_MODULE, "utf-8");
    await writeFile(
      join(dir, ".context", "config.yaml"),
      [
        "version: 1",
        "name: Loader Test Vault",
        "governance:",
        "  module: ./vault-gov.mjs",
        "",
      ].join("\n"),
      "utf-8",
    );

    const bundle = await loadGovernanceBundle({ vaultPath: dir, env: {} });
    expect(bundle).not.toBeNull();
    expect(await bundle!.hooks!.canCommit!("anyone", { documentId: "d" }, "update")).toBe(
      false,
    );
  });

  it("throws ConfigError on a malformed module (misconfiguration fails loud, never silently open)", async () => {
    const modPath = join(dir, "broken.mjs");
    await writeFile(modPath, `export const notAFactory = 42;\n`, "utf-8");

    await expect(loadGovernanceBundle({ module: modPath, env: {} })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("throws ConfigError when the module path does not exist", async () => {
    await expect(
      loadGovernanceBundle({ module: join(dir, "missing.mjs"), env: {} }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
