/**
 * Central vault registry (~/.contextnest/config.yaml).
 *
 * Maps short aliases to vault paths so the CLI and MCP server can target any
 * vault from any working directory — analogous to AWS named profiles, but with
 * "vault"/alias terminology. The registry stores paths only; vaults are never
 * physically relocated.
 *
 * Resolution (highest precedence first), implemented by resolveVaultPath():
 *   1. explicit --vault <alias> flag        → registry lookup
 *   2. CONTEXTNEST_VAULT env (alias)         → registry lookup
 *   3. CONTEXTNEST_VAULT_PATH env (abs path) → used directly (backward compat)
 *   4. local vault found by walking up cwd   → .context/config.yaml (legacy)
 *   5. registry `default:` alias             → registry lookup
 *   6. cwd fallback
 */

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { VaultRegistry, VaultRegistryEntry } from "./types.js";

/**
 * Allowed characters for a vault alias. Restricted to letters, digits, hyphens
 * and underscores so an alias is always safe to type after `--vault` and to use
 * as a YAML key without quoting.
 */
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;

const vaultRegistryEntrySchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
});

const vaultRegistrySchema = z.object({
  version: z.number().default(1),
  default: z.string().optional(),
  vaults: z.record(z.string(), vaultRegistryEntrySchema).default({}),
});

/** A fresh empty registry. Constructed per call so the nested `vaults` object is never shared. */
function emptyRegistry(): VaultRegistry {
  return { version: 1, vaults: {} };
}

/** Where the registry lives. Honors CONTEXTNEST_CONFIG_DIR for tests/sandboxing. */
export function getRegistryDir(): string {
  return process.env.CONTEXTNEST_CONFIG_DIR || join(homedir(), ".contextnest");
}

export function getRegistryPath(): string {
  return join(getRegistryDir(), "config.yaml");
}

/** Read + validate the registry. Returns an empty registry if none exists. */
export function readRegistry(): VaultRegistry {
  const path = getRegistryPath();
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry();
    }
    throw err;
  }
  const raw = yaml.load(content);
  if (raw == null) return emptyRegistry();
  const result = vaultRegistrySchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid vault registry (${path}): ${messages.join("; ")}`);
  }
  return result.data as VaultRegistry;
}

export function writeRegistry(registry: VaultRegistry): void {
  const dir = getRegistryDir();
  // 0o700/0o600: the registry lists every vault path; keep it owner-only so it
  // doesn't leak filesystem topology on shared hosts. (mode is a no-op on Windows.)
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const content = yaml.dump(registry, { lineWidth: -1, noRefs: true });
  // Atomic write: a crash mid-write leaves the old registry intact rather than
  // a truncated/corrupt file. Temp file is on the same dir so rename is atomic.
  const target = getRegistryPath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  try {
    renameSync(tmp, target);
  } catch (err) {
    // On Windows, rename over an existing file can throw EPERM if the target is
    // briefly locked (antivirus, a concurrent reader). Fall back to a copy, then
    // best-effort remove the temp file.
    try {
      copyFileSync(tmp, target);
      try {
        unlinkSync(tmp);
      } catch {
        // temp cleanup is best-effort
      }
    } catch {
      throw new ConfigError(
        `Failed to write vault registry to "${target}": ${(err as Error).message}. A temp file may remain at "${tmp}".`,
      );
    }
  }
}

/** True if `dir` looks like a vault root (has .context/config.yaml). */
export function isVaultRoot(dir: string): boolean {
  try {
    return statSync(join(dir, ".context", "config.yaml")).isFile();
  } catch {
    return false;
  }
}

/** Walk up from `cwd` looking for a vault root. Returns the path or null. */
export function findLocalVault(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (isVaultRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export interface AddVaultOptions {
  description?: string;
  setDefault?: boolean;
  /** Overwrite an existing alias instead of throwing. */
  force?: boolean;
}

/**
 * Register a vault path under an alias. Validates the path is a real vault.
 * If the registry has no default yet, the first added vault becomes default.
 */
export function addVault(alias: string, vaultPath: string, opts: AddVaultOptions = {}): VaultRegistry {
  if (!alias.trim()) {
    throw new ConfigError("Vault alias must not be empty");
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw new ConfigError(
      `Vault alias "${alias}" is invalid — use only letters, digits, hyphens, or underscores.`,
    );
  }
  if (!isVaultRoot(vaultPath)) {
    throw new ConfigError(
      `"${vaultPath}" is not a Context Nest vault (no .context/config.yaml). Run \`ctx init\` there first.`,
    );
  }
  const registry = readRegistry();
  if (registry.vaults[alias] && !opts.force) {
    throw new ConfigError(
      `Vault alias "${alias}" already exists (-> ${registry.vaults[alias].path}). Use --force to overwrite.`,
    );
  }
  const entry: VaultRegistryEntry = { path: vaultPath };
  if (opts.description) entry.description = opts.description;
  registry.vaults[alias] = entry;
  if (opts.setDefault || !registry.default) {
    registry.default = alias;
  }
  writeRegistry(registry);
  return registry;
}

export function removeVault(alias: string): VaultRegistry {
  const registry = readRegistry();
  if (!registry.vaults[alias]) {
    throw new ConfigError(`No vault registered under alias "${alias}".`);
  }
  delete registry.vaults[alias];
  if (registry.default === alias) {
    delete registry.default;
  }
  writeRegistry(registry);
  return registry;
}

export function setDefaultVault(alias: string): VaultRegistry {
  const registry = readRegistry();
  if (!registry.vaults[alias]) {
    throw new ConfigError(`No vault registered under alias "${alias}".`);
  }
  registry.default = alias;
  writeRegistry(registry);
  return registry;
}

export interface VaultListEntry {
  alias: string;
  path: string;
  /** Registry description, or the vault's own config name when unset. */
  description?: string;
  isDefault: boolean;
  /** Whether the path currently resolves to a real vault. */
  exists: boolean;
}

/** List registered vaults with resolved descriptions and existence checks. */
export function listVaults(): VaultListEntry[] {
  const registry = readRegistry();
  return Object.entries(registry.vaults).map(([alias, entry]) => ({
    alias,
    path: entry.path,
    description: entry.description ?? readVaultName(entry.path),
    isDefault: registry.default === alias,
    exists: isVaultRoot(entry.path),
  }));
}

/** Read a vault's own `name` from its config (best-effort, for display). */
function readVaultName(vaultPath: string): string | undefined {
  try {
    const raw = yaml.load(readFileSync(join(vaultPath, ".context", "config.yaml"), "utf-8"));
    const name = (raw as { name?: unknown })?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an alias to a validated vault path, throwing a clear error otherwise.
 * Accepts an already-loaded registry to avoid a redundant disk read when the
 * caller has one in hand.
 */
function resolveAliasOrThrow(alias: string, registry: VaultRegistry = readRegistry()): string {
  const entry = registry.vaults[alias];
  if (!entry) {
    const known = Object.keys(registry.vaults);
    const hint = known.length ? ` Known aliases: ${known.join(", ")}.` : " No vaults registered yet — add one with `ctx vault add`.";
    throw new ConfigError(`Unknown vault alias "${alias}".${hint}`);
  }
  if (!isVaultRoot(entry.path)) {
    throw new ConfigError(
      `Vault alias "${alias}" points to "${entry.path}", which is no longer a vault (missing .context/config.yaml).`,
    );
  }
  return entry.path;
}

export type VaultResolutionSource =
  | "flag"
  | "env-alias"
  | "env-path"
  | "local"
  | "default"
  | "cwd";

export interface ResolveVaultOptions {
  /** Alias from an explicit --vault flag. */
  vaultAlias?: string;
  /** Working directory to resolve from. Defaults to process.cwd(). */
  cwd?: string;
}

export interface ResolvedVault {
  path: string;
  source: VaultResolutionSource;
  /** The alias used, when resolution went through the registry. */
  alias?: string;
}

/**
 * Resolve which vault to operate on, applying the documented precedence.
 * Synchronous so it can run at CLI/MCP startup.
 */
export function resolveVaultPath(opts: ResolveVaultOptions = {}): ResolvedVault {
  const cwd = opts.cwd ?? process.cwd();

  // 1. explicit --vault flag
  if (opts.vaultAlias) {
    return { path: resolveAliasOrThrow(opts.vaultAlias), source: "flag", alias: opts.vaultAlias };
  }

  // 2. CONTEXTNEST_VAULT env (alias)
  const envAlias = process.env.CONTEXTNEST_VAULT;
  if (envAlias) {
    return { path: resolveAliasOrThrow(envAlias), source: "env-alias", alias: envAlias };
  }

  // 3. CONTEXTNEST_VAULT_PATH env (absolute path) — backward compat
  if (process.env.CONTEXTNEST_VAULT_PATH) {
    return { path: process.env.CONTEXTNEST_VAULT_PATH, source: "env-path" };
  }

  // 4. local vault from cwd walk-up — backward compat
  const local = findLocalVault(cwd);
  if (local) {
    return { path: local, source: "local" };
  }

  // 5. registry default alias. This is an implicit fallback, not an explicit
  // user request, so a stale default (vault deleted/moved) must NOT throw —
  // that would lock the user out of every command. Fall through to cwd instead.
  // (Explicit --vault / CONTEXTNEST_VAULT above still throw on a bad alias.)
  const registry = readRegistry();
  const defaultEntry = registry.default ? registry.vaults[registry.default] : undefined;
  if (defaultEntry && isVaultRoot(defaultEntry.path)) {
    return { path: defaultEntry.path, source: "default", alias: registry.default };
  }

  // 6. cwd fallback
  return { path: cwd, source: "cwd" };
}
