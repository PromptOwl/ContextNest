/**
 * Central vault registry (~/.contextnest/config.yaml).
 *
 * Maps short aliases to vault paths so the CLI and MCP server can target any
 * vault from any working directory — analogous to AWS named profiles, but with
 * "vault"/alias terminology. The registry stores paths only; vaults are never
 * physically relocated.
 *
 * Resolution (highest precedence first), implemented by resolveVaultPath():
 *   1. explicit --vault <alias> flag         → registry lookup
 *   2. CONTEXTNEST_VAULT env (alias)         → registry lookup
 *   3. CONTEXTNEST_VAULT_PATH env (abs path) → used directly (backward compat)
 *   4. positional arg (MCP `<arg>`)          → alias, or abs/relative vault path
 *   5. local vault found by walking up cwd   → .context/config.yaml (legacy)
 *   6. registry `default:` alias             → registry lookup
 *   7. cwd fallback
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
import { dirname, isAbsolute, join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { ConfigError, UnknownAliasError } from "./errors.js";
import type { RemoteNestSpec, VaultRegistry, VaultRegistryEntry } from "./types.js";

/**
 * Allowed characters for a vault alias. Restricted to letters, digits, hyphens
 * and underscores so an alias is always safe to type after `--vault` and to use
 * as a YAML key without quoting. Exported so the CLI's interactive prompt can
 * validate against the single source of truth.
 */
export const ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;

const vaultRegistryEntrySchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
});

/**
 * Auth for HTTP remotes. Only env-var *references* are storable; any other key
 * (a raw `bearer:`/`token:` value) is rejected with a message that names the
 * env-ref fields, so a hand-edited secret can never silently live in the
 * registry file.
 */
const REMOTE_AUTH_KEYS = new Set(["bearer_env", "header_name", "header_env"]);
const remoteAuthSchema = z
  .object({
    bearer_env: z.string().min(1).optional(),
    header_name: z.string().min(1).optional(),
    header_env: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((val, rc) => {
    for (const key of Object.keys(val)) {
      if (!REMOTE_AUTH_KEYS.has(key)) {
        rc.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown auth key "${key}" — store secrets as env-var references (bearer_env / header_env), never as raw values`,
        });
      }
    }
  });

/** Hosts where cleartext http is acceptable (local development/testing). */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
}

const remoteNestSpecSchema = z
  .discriminatedUnion("transport", [
    z.object({
      transport: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      description: z.string().optional(),
      timeout_ms: z.number().int().positive().optional(),
    }),
    z.object({
      transport: z.literal("http"),
      url: z.string().min(1),
      auth: remoteAuthSchema.optional(),
      description: z.string().optional(),
      timeout_ms: z.number().int().positive().optional(),
    }),
  ])
  // superRefine on the UNION, not its options — discriminatedUnion requires
  // plain ZodObject options, so per-option effects would fail to construct.
  .superRefine((spec, rc) => {
    if (spec.transport !== "http") return;
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      rc.addIssue({
        code: z.ZodIssueCode.custom,
        message: `url "${spec.url}" is not a valid URL`,
      });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      rc.addIssue({
        code: z.ZodIssueCode.custom,
        message: `url must use http(s), got "${url.protocol}//"`,
      });
      return;
    }
    // Credentials over cleartext http would put the bearer token/header value
    // on the wire unencrypted. Refuse outright (not just a warning) unless the
    // host is loopback — local development is the one legitimate cleartext case.
    if (spec.auth && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      rc.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `refusing to send credentials over cleartext ${url.protocol}// to "${url.hostname}" — ` +
          `use https://, or a loopback address (localhost/127.x) for local testing`,
      });
    }
  });

const vaultRegistrySchema = z
  .object({
    version: z.number().default(1),
    default: z.string().optional(),
    // Validate alias keys on read too, not just in addVault — a hand-edited entry
    // like "my vault" would otherwise be silently usable via CONTEXTNEST_VAULT,
    // bypassing the shell-safety invariant.
    vaults: z.record(z.string().regex(ALIAS_PATTERN), vaultRegistryEntrySchema).default({}),
    // Remote nests live in their own top-level map so pre-remote CLIs (which
    // strip unknown top-level keys) keep working against a registry that has
    // them — extending `vaults` entries would fail their whole-registry parse.
    remotes: z.record(z.string().regex(ALIAS_PATTERN), remoteNestSpecSchema).optional(),
  })
  .superRefine((reg, rc) => {
    // One alias namespace across both maps: --vault/CONTEXTNEST_VAULT/default
    // must never be ambiguous about which entry they name.
    for (const alias of Object.keys(reg.remotes ?? {})) {
      if (reg.vaults[alias]) {
        rc.addIssue({
          code: z.ZodIssueCode.custom,
          message: `alias "${alias}" is registered as both a vault and a remote — aliases share one namespace`,
        });
      }
    }
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
  try {
    // Inside the try so the finally also cleans up a temp file left behind when
    // writeFileSync itself fails partway (e.g. ENOSPC, permission error).
    writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
    try {
      renameSync(tmp, target);
    } catch (renameErr) {
      // Fall back to a copy ONLY on Windows EPERM (the target can be briefly
      // locked by antivirus or a concurrent reader). Every other failure —
      // including all Unix errors — is surfaced rather than masked by a copy.
      if (process.platform !== "win32" || (renameErr as NodeJS.ErrnoException).code !== "EPERM") {
        throw renameErr;
      }
      try {
        copyFileSync(tmp, target);
      } catch (copyErr) {
        throw new ConfigError(
          `Failed to write vault registry to "${target}": ${(copyErr as Error).message}.`,
        );
      }
    }
  } finally {
    // Remove the temp file on every path: it's already gone after a successful
    // rename (ENOENT, ignored here), and this prevents leaked `.<pid>.tmp` files
    // when a write fails (e.g. ENOSPC), since each PID uses a distinct name.
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
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
  // Store absolute paths only: the registry is read from arbitrary working
  // directories, so a relative path would resolve differently at lookup time.
  if (!isAbsolute(vaultPath)) {
    throw new ConfigError(`Vault path must be absolute, got "${vaultPath}".`);
  }
  if (!isVaultRoot(vaultPath)) {
    throw new ConfigError(
      `"${vaultPath}" is not a Context Nest vault (no .context/config.yaml). Run \`ctx init\` there first.`,
    );
  }
  const registry = readRegistry();
  // One alias namespace: a remote under this alias always blocks (a --force
  // local overwrite of a remote would silently change the entry's kind).
  if (registry.remotes?.[alias]) {
    throw new ConfigError(
      `Alias "${alias}" already exists as a remote nest. Remove it first with \`ctx vault remove ${alias}\`.`,
    );
  }
  const isNew = !registry.vaults[alias];
  if (!isNew && !opts.force) {
    throw new ConfigError(
      `Vault alias "${alias}" already exists (-> ${registry.vaults[alias].path}). Use --force to overwrite.`,
    );
  }
  const entry: VaultRegistryEntry = { path: vaultPath };
  if (opts.description) entry.description = opts.description;
  registry.vaults[alias] = entry;
  // Auto-promote to default only for a brand-new first entry. A --force update
  // of an existing alias must not silently grab the default when it's unset.
  if (opts.setDefault || (isNew && !registry.default)) {
    registry.default = alias;
  }
  writeRegistry(registry);
  return registry;
}

export interface AddRemoteOptions {
  setDefault?: boolean;
  /** Overwrite an existing REMOTE entry under this alias instead of throwing. */
  force?: boolean;
}

/**
 * Register a remote nest (MCP endpoint) under an alias, in the registry's
 * top-level `remotes:` map. Shares one alias namespace with local vaults.
 */
export function addRemote(
  alias: string,
  spec: RemoteNestSpec,
  opts: AddRemoteOptions = {},
): VaultRegistry {
  if (!alias.trim()) {
    throw new ConfigError("Vault alias must not be empty");
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw new ConfigError(
      `Vault alias "${alias}" is invalid — use only letters, digits, hyphens, or underscores.`,
    );
  }
  const parsed = remoteNestSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message);
    throw new ConfigError(`Invalid remote nest spec: ${messages.join("; ")}`);
  }
  const registry = readRegistry();
  if (registry.vaults[alias]) {
    throw new ConfigError(
      `Vault alias "${alias}" already exists (-> ${registry.vaults[alias].path}). Choose another alias or remove it first.`,
    );
  }
  const isNew = !registry.remotes?.[alias];
  if (!isNew && !opts.force) {
    throw new ConfigError(
      `Remote alias "${alias}" already exists. Use --force to overwrite.`,
    );
  }
  registry.remotes = { ...(registry.remotes ?? {}), [alias]: parsed.data };
  // Same promotion rule as addVault: a brand-new entry becomes the default only
  // when nothing else is registered yet, or when explicitly requested.
  if (
    opts.setDefault ||
    (isNew &&
      !registry.default &&
      Object.keys(registry.vaults).length === 0 &&
      Object.keys(registry.remotes).length === 1)
  ) {
    registry.default = alias;
  }
  writeRegistry(registry);
  return registry;
}

export interface RemoveVaultResult {
  registry: VaultRegistry;
  /** True if the removed alias was the default (its default slot is now empty). */
  wasDefault: boolean;
}

/** Unregister an alias — local vault or remote nest alike. */
export function removeVault(alias: string): RemoveVaultResult {
  const registry = readRegistry();
  if (registry.vaults[alias]) {
    delete registry.vaults[alias];
  } else if (registry.remotes?.[alias]) {
    delete registry.remotes[alias];
    if (Object.keys(registry.remotes).length === 0) delete registry.remotes;
  } else {
    throw new ConfigError(`No vault registered under alias "${alias}".`);
  }
  const wasDefault = registry.default === alias;
  if (wasDefault) {
    delete registry.default;
  }
  writeRegistry(registry);
  return { registry, wasDefault };
}

/** Set the default alias. A remote nest may be the default. */
export function setDefaultVault(alias: string): VaultRegistry {
  const registry = readRegistry();
  if (!registry.vaults[alias] && !registry.remotes?.[alias]) {
    throw new ConfigError(`No vault registered under alias "${alias}".`);
  }
  registry.default = alias;
  writeRegistry(registry);
  return registry;
}

export interface VaultListEntry {
  alias: string;
  /** Local vault on disk, or a remote nest reached over MCP. */
  kind: "local" | "remote";
  /** Local entries only: absolute vault path. */
  path?: string;
  /** Remote entries only. */
  transport?: RemoteNestSpec["transport"];
  url?: string;
  command?: string;
  args?: string[];
  /** Registry description, or (local only) the vault's own config name when unset. */
  description?: string;
  isDefault: boolean;
  /**
   * Local entries: whether the path currently resolves to a real vault.
   * Remote entries: omitted — reachability is only known by probing, which
   * `vault list` deliberately never does implicitly.
   */
  exists?: boolean;
}

/** List registered vaults and remote nests with descriptions and existence checks. */
export function listVaults(): VaultListEntry[] {
  const registry = readRegistry();
  const locals: VaultListEntry[] = Object.entries(registry.vaults).map(([alias, entry]) => ({
    alias,
    kind: "local" as const,
    path: entry.path,
    description: entry.description ?? readVaultName(entry.path),
    isDefault: registry.default === alias,
    exists: isVaultRoot(entry.path),
  }));
  const remotes: VaultListEntry[] = Object.entries(registry.remotes ?? {}).map(
    ([alias, spec]) => ({
      alias,
      kind: "remote" as const,
      transport: spec.transport,
      ...(spec.transport === "http"
        ? { url: spec.url }
        : { command: spec.command, args: spec.args }),
      description: spec.description,
      isDefault: registry.default === alias,
    }),
  );
  return [...locals, ...remotes];
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
    throw new UnknownAliasError(alias, `Unknown vault alias "${alias}".${hint}`);
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
  | "arg"
  | "local"
  | "default"
  | "cwd";

export interface ResolveVaultOptions {
  /** Alias from an explicit --vault flag. */
  vaultAlias?: string;
  /**
   * Positional argument (the MCP server's `contextnest-mcp <arg>`): a registered
   * alias or an absolute vault path. Sits between the env vars and the local
   * walk-up in precedence, matching the documented MCP order.
   */
  argPath?: string;
  /** Working directory to resolve from. Defaults to process.cwd(). */
  cwd?: string;
}

export interface ResolvedVault {
  path: string;
  source: VaultResolutionSource;
  /** The alias used, when resolution went through the registry. */
  alias?: string;
  /**
   * Non-fatal advisory (e.g. a stale CONTEXTNEST_VAULT that was ignored). The
   * CLI/MCP surface this on stderr so the user understands why a fallback path
   * was chosen instead of silently operating on the wrong vault.
   */
  warning?: string;
}

/**
 * A resolved nest: either a local vault path or a registered remote nest.
 * `resolveNest` is the remote-aware resolver; `resolveVaultPath` wraps it for
 * the (many) callers whose operation is inherently local.
 */
export type ResolvedNest =
  | ({ kind: "local" } & ResolvedVault)
  | {
      kind: "remote";
      alias: string;
      remote: RemoteNestSpec;
      source: VaultResolutionSource;
      warning?: string;
    };

/** One-line human description of a remote's endpoint, for messages/UIs. */
export function describeRemoteEndpoint(spec: RemoteNestSpec): string {
  return spec.transport === "http"
    ? spec.url
    : [spec.command, ...(spec.args ?? [])].join(" ");
}

/**
 * Resolve which nest to operate on — local vault or remote — applying the
 * documented precedence. An alias naming a `remotes:` entry resolves at the
 * same precedence steps a local alias would (flag, env alias, positional arg,
 * registry default). Synchronous so it can run at CLI/MCP startup.
 */
export function resolveNest(opts: ResolveVaultOptions = {}): ResolvedNest {
  const cwd = opts.cwd ?? process.cwd();

  // 1. explicit --vault flag — per-command and explicit, so a bad alias throws.
  if (opts.vaultAlias) {
    const reg = readRegistry();
    const remote = reg.remotes?.[opts.vaultAlias];
    if (remote) {
      return { kind: "remote", alias: opts.vaultAlias, remote, source: "flag" };
    }
    return {
      kind: "local",
      path: resolveAliasOrThrow(opts.vaultAlias, reg),
      source: "flag",
      alias: opts.vaultAlias,
    };
  }

  // Lazily read the registry at most once, shared across the branches below.
  let registry: VaultRegistry | undefined;
  const getRegistry = (): VaultRegistry => (registry ??= readRegistry());

  // Advisory about an ignored set-and-forget env var. It is only surfaced when
  // we ultimately fall through to the bare cwd (step 7) — a concrete resolution
  // (env-path, arg, local, default) means the user has a working vault, so
  // nagging on every command would be noise.
  let warning: string | undefined;

  // 2. CONTEXTNEST_VAULT env (alias). Unlike the flag, this is a persistent
  // set-and-forget setting, so a stale/unknown alias must NOT lock the user out
  // of every command — use it when valid, otherwise warn and fall through.
  const envAlias = process.env.CONTEXTNEST_VAULT;
  if (envAlias) {
    const envRemote = getRegistry().remotes?.[envAlias];
    if (envRemote) {
      return { kind: "remote", alias: envAlias, remote: envRemote, source: "env-alias" };
    }
    const entry = getRegistry().vaults[envAlias];
    if (entry && isVaultRoot(entry.path)) {
      return { kind: "local", path: entry.path, source: "env-alias", alias: envAlias };
    }
    warning ??= entry
      ? `CONTEXTNEST_VAULT="${envAlias}" points to "${entry.path}", which is no longer a vault — ignoring it.`
      : `CONTEXTNEST_VAULT="${envAlias}" is not a registered vault alias — ignoring it.`;
  }

  // 3. CONTEXTNEST_VAULT_PATH env (absolute path). Validate it like every other
  // source so a stale/mistyped path warns and falls through rather than handing
  // back a non-vault that fails later with a cryptic ENOENT.
  const envPath = process.env.CONTEXTNEST_VAULT_PATH;
  if (envPath) {
    if (isVaultRoot(envPath)) {
      return { kind: "local", path: envPath, source: "env-path" };
    }
    warning ??= `CONTEXTNEST_VAULT_PATH="${envPath}" is not a vault (no .context/config.yaml) — ignoring it.`;
  }

  // 4. positional arg (MCP `contextnest-mcp <arg>`): a registered alias or an
  // absolute vault path. It is an *explicit* selection, so anything that doesn't
  // resolve to a real vault throws rather than silently falling through to a
  // different one: a stale alias, a non-absolute non-alias (typo), AND an
  // absolute path that isn't (yet) a vault.
  if (opts.argPath) {
    const arg = opts.argPath;
    const argRemote = getRegistry().remotes?.[arg];
    if (argRemote) {
      return { kind: "remote", alias: arg, remote: argRemote, source: "arg" };
    }
    if (getRegistry().vaults[arg]) {
      return {
        kind: "local",
        path: resolveAliasOrThrow(arg, getRegistry()),
        source: "arg",
        alias: arg,
      };
    }
    // Not an alias → treat as a path. A relative path is resolved against cwd
    // (backward compat: `contextnest-mcp ./vault` / `../vault` worked before the
    // registry landed). Either way the resolved path must be a real vault, so a
    // typo still surfaces a clear error instead of silently using a bogus dir.
    const resolvedArg = isAbsolute(arg) ? arg : join(cwd, arg);
    if (!isVaultRoot(resolvedArg)) {
      throw new ConfigError(
        `"${arg}" is not a registered vault alias and is not a vault directory (no .context/config.yaml).`,
      );
    }
    return { kind: "local", path: resolvedArg, source: "arg" };
  }

  // 5. local vault from cwd walk-up — backward compat. Carry any stale-env
  // advisory: an explicit override was set and ignored, so the caller (e.g.
  // `ctx vault which`) can surface it even though a vault did resolve.
  const local = findLocalVault(cwd);
  if (local) {
    return { kind: "local", path: local, source: "local", warning };
  }

  // 6. registry default alias. Also an implicit fallback, so a stale default
  // (vault deleted/moved) must NOT throw — fall through to cwd instead.
  const reg = getRegistry();
  const defaultRemote = reg.default ? reg.remotes?.[reg.default] : undefined;
  if (reg.default && defaultRemote) {
    return { kind: "remote", alias: reg.default, remote: defaultRemote, source: "default", warning };
  }
  const defaultEntry = reg.default ? reg.vaults[reg.default] : undefined;
  if (defaultEntry && isVaultRoot(defaultEntry.path)) {
    return { kind: "local", path: defaultEntry.path, source: "default", alias: reg.default, warning };
  }

  // 7. cwd fallback.
  return { kind: "local", path: cwd, source: "cwd", warning };
}

/**
 * Resolve which LOCAL vault to operate on. Wraps {@link resolveNest} and
 * throws a clear ConfigError when resolution lands on a remote nest — callers
 * of this function (init/index/checkpoint and every direct-filesystem path)
 * cannot operate over MCP.
 */
export function resolveVaultPath(opts: ResolveVaultOptions = {}): ResolvedVault {
  const nest = resolveNest(opts);
  if (nest.kind === "remote") {
    throw new ConfigError(
      `Vault alias "${nest.alias}" is a remote nest (${describeRemoteEndpoint(nest.remote)}) — ` +
        `this operation is local-only and cannot run against a remote.`,
    );
  }
  const { kind: _kind, ...resolved } = nest;
  return resolved;
}
