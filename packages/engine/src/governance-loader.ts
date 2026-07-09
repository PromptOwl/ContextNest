/**
 * Dynamic governance module loader.
 *
 * Lets a deployment inject a proprietary RBAC / provenance implementation
 * into any engine surface (CLI, MCP server, custom bridge) WITHOUT the
 * AGPL engine referencing that implementation. The engine only knows the
 * `GovernanceBundle` contract; the module is resolved at runtime from:
 *
 *   1. an explicit `module` option (highest precedence),
 *   2. the `CONTEXTNEST_GOVERNANCE_MODULE` environment variable,
 *   3. the vault's `.context/config.yaml` `governance.module` field.
 *
 * The module must export (default or named `createGovernance`) a factory:
 *
 *   (ctx: { vaultPath?: string }) => GovernanceBundle | Promise<GovernanceBundle>
 *
 * Misconfiguration fails LOUD with `ConfigError` — a vault configured for
 * governance must never silently fall open because its module didn't load.
 */

import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GovernanceBundle, GovernanceHooks } from "./types.js";
import { ConfigError } from "./errors.js";
import { NestStorage } from "./storage.js";

export interface LoadGovernanceOptions {
  /** Explicit module id/path. Wins over env and vault config. */
  module?: string;
  /** Vault root — used to read `.context/config.yaml` `governance.module`
   * and to resolve relative module paths. */
  vaultPath?: string;
  /** Environment consulted for `CONTEXTNEST_GOVERNANCE_MODULE`.
   * Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Env var naming the governance module for CLI/MCP deployments. */
export const GOVERNANCE_MODULE_ENV = "CONTEXTNEST_GOVERNANCE_MODULE";

/**
 * Resolve and load the deployment's governance module, if any.
 *
 * Returns `null` when nothing is configured — callers fall back to their
 * own default (typically `allowAllGovernance` for local single-user use).
 * Throws `ConfigError` when a module IS configured but cannot be loaded or
 * does not satisfy the factory contract.
 */
export async function loadGovernanceBundle(
  opts: LoadGovernanceOptions = {},
): Promise<GovernanceBundle | null> {
  const env = opts.env ?? process.env;
  const specifier =
    opts.module ??
    (env[GOVERNANCE_MODULE_ENV]?.trim() || undefined) ??
    (await readConfiguredModule(opts.vaultPath));

  if (!specifier) return null;

  const importable = toImportSpecifier(specifier, opts.vaultPath);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(importable)) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Failed to load governance module "${specifier}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const factory = mod.createGovernance ?? mod.default;
  if (typeof factory !== "function") {
    throw new ConfigError(
      `Governance module "${specifier}" must export a factory function ` +
        `(default export or named "createGovernance") returning a GovernanceBundle.`,
    );
  }

  let bundle: unknown;
  try {
    bundle = await (factory as (ctx: { vaultPath?: string }) => unknown)({
      vaultPath: opts.vaultPath,
    });
  } catch (err) {
    throw new ConfigError(
      `Governance module "${specifier}" factory threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  validateBundleShape(bundle, specifier);
  return bundle as GovernanceBundle;
}

/** Read `governance.module` from the vault's `.context/config.yaml`. */
async function readConfiguredModule(
  vaultPath: string | undefined,
): Promise<string | undefined> {
  if (!vaultPath) return undefined;
  try {
    const config = await new NestStorage(vaultPath).readConfig();
    return config?.governance?.module?.trim() || undefined;
  } catch {
    // Unreadable/absent config is "not configured", not an error — the
    // loud-failure contract applies only once a module IS named.
    return undefined;
  }
}

/**
 * Convert a specifier to something `import()` accepts. Relative paths
 * resolve against the vault root (so a vault can ship `./governance.mjs`);
 * absolute paths become file URLs (Windows-safe); bare specifiers pass
 * through to normal module resolution.
 */
function toImportSpecifier(specifier: string, vaultPath?: string): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = vaultPath ?? process.cwd();
    return pathToFileURL(join(base, specifier)).href;
  }
  if (isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
}

/** Shape-validate a loaded bundle so misconfiguration fails loud. */
function validateBundleShape(bundle: unknown, specifier: string): void {
  if (bundle === null || typeof bundle !== "object") {
    throw new ConfigError(
      `Governance module "${specifier}" factory must return an object ` +
        `({ hooks?, recorder? }), got ${bundle === null ? "null" : typeof bundle}.`,
    );
  }
  const b = bundle as GovernanceBundle;

  if (b.hooks !== undefined) {
    const hooks = b.hooks as GovernanceHooks;
    const required = ["isCzar", "canIngest", "isDocOwner"] as const;
    for (const name of required) {
      if (typeof hooks[name] !== "function") {
        throw new ConfigError(
          `Governance module "${specifier}" hooks.${name} must be a function.`,
        );
      }
    }
    for (const name of ["canRead", "canCommit"] as const) {
      if (hooks[name] !== undefined && typeof hooks[name] !== "function") {
        throw new ConfigError(
          `Governance module "${specifier}" hooks.${name} must be a function when present.`,
        );
      }
    }
  }

  if (b.recorder !== undefined && typeof b.recorder.record !== "function") {
    throw new ConfigError(
      `Governance module "${specifier}" recorder.record must be a function.`,
    );
  }
}
