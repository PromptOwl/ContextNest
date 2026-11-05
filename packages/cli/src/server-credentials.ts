/**
 * server-credentials.ts — API keys saved by `ctx login`, one per ContextNest
 * server, so `ctx push` and remote `--vault` aliases stop asking for a key.
 *
 * The map of servers is pure data (unit-tested in server-credentials.test.ts).
 * It is persisted as ONE secret in the secure credential store
 * (credentials.ts: OS keyring, else the encrypted file) — never plaintext.
 * Keyed by normalized server URL so one machine can hold keys for several
 * servers at once (hosted + self-hosted + a client's). A key can also be saved
 * for one nest (`<server>/nests/<id>`); lookups take the longest match, so a
 * nest-scoped key wins over the server-wide one for that nest only. A second
 * account on the same server (`ctx login --account <name>`) keeps its keys
 * under `<scope>#<name>`; an alias picks it with its registry `account`. A ctx
 * that predates accounts never matches those entries (its prefix match needs
 * a `/`), so it keeps using the unnamed account's keys.
 *
 * Writes are read-modify-write on that one secret and not locked: two
 * `ctx login` runs finishing at the same instant can drop one entry (re-run
 * it). Logins are interactive and rare, so a lock isn't worth its failure modes.
 */
import fs from "node:fs";
import pathMod from "node:path";
import { ACCOUNT_NAME_PATTERN, getRegistryDir } from "@promptowl/contextnest-engine";
import {
  CredentialStore,
  CredentialStoreError,
  NO_SECURE_STORE_HELP,
  type CredentialStoreOptions,
} from "./credentials.js";

/** Secure-store account the server map lives under. */
export const SERVERS_ACCOUNT = "contextnest-servers";

export interface ServerCredential {
  /** Bearer token (a `cnst_…` API key) for this server. */
  token: string;
  /** Optional human label — typically the signed-in account email. */
  label?: string;
  /** ISO timestamp the credential was stored/refreshed. */
  updatedAt?: string;
}

export interface ServerMap {
  version: number;
  /** Normalized URL of the default server (used when a command omits --server). */
  default?: string;
  /** Credentials keyed by normalized server URL. */
  servers: Record<string, ServerCredential>;
}

/**
 * Canonical form of a server URL: scheme + host lowercased (via WHATWG URL),
 * no trailing slash, no query or fragment. Throws for anything that isn't
 * http(s) so a typo can't key a credential under a garbage string.
 */
export function normalizeServerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid server URL: "${raw}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Server URL must be http(s): "${raw}"`);
  }
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/+$/, "");
}

export function emptyServerMap(): ServerMap {
  return { version: 1, servers: {} };
}

/** Highest map format this CLI understands; a newer one is never rewritten. */
export const SERVER_MAP_VERSION = 1;

/** Scope key for one nest on a server: `<server>/nests/<id>`. */
export function nestScopeUrl(server: string, nestId: string): string {
  const id = nestId.trim();
  if (!id || /[/?#\\\s]/.test(id)) throw new Error(`Invalid nest id: "${nestId}"`);
  return `${normalizeServerUrl(server)}/nests/${encodeURIComponent(id)}`;
}

/** Map key for `scope` (a normalized server or nest URL) under `account`; the unnamed account is the bare URL. */
export function accountKey(scope: string, account?: string): string {
  if (account === undefined) return scope;
  if (!ACCOUNT_NAME_PATTERN.test(account)) throw new Error(`Invalid account name: "${account}"`);
  return `${scope}#${account}`;
}

/** A map key split into its URL and account. A normalized URL never holds a `#`. */
export function splitAccountKey(key: string): { scope: string; account?: string } {
  const i = key.indexOf("#");
  return i < 0 ? { scope: key } : { scope: key.slice(0, i), account: key.slice(i + 1) };
}

/** True when `key` is a nest-scoped entry (`…/nests/<id>`), not a server-wide one. */
export function isNestScope(key: string): boolean {
  return /\/nests\/[^/]+$/.test(splitAccountKey(key).scope);
}

/** The map key for `url` (a URL, or a key already holding `#<account>`). */
function mapKey(url: string, account?: string): string {
  const { scope, account: own } = splitAccountKey(url);
  return accountKey(normalizeServerUrl(scope), account ?? own);
}

/** Add or replace the credential for `url`. The first server-wide key of the unnamed account becomes the default. */
export function upsertServer(map: ServerMap, url: string, cred: ServerCredential, account?: string): ServerMap {
  const key = mapKey(url, account);
  return {
    version: map.version || SERVER_MAP_VERSION,
    default: map.default ?? (isNestScope(key) || splitAccountKey(key).account ? undefined : key),
    servers: { ...map.servers, [key]: cred },
  };
}

/** Remove `url` (or a `<url>#<account>` key). If it was the default, promote the next remaining server (or clear). */
export function removeServer(map: ServerMap, url: string): ServerMap {
  const key = mapKey(url);
  const servers = { ...map.servers };
  delete servers[key];
  let def = map.default;
  if (def === key) def = Object.keys(servers).find((k) => !isNestScope(k) && !splitAccountKey(k).account);
  return { version: map.version || SERVER_MAP_VERSION, servers, ...(def ? { default: def } : {}) };
}

/** Saved keys of `account` for `url`: the server-wide key and every nest-scoped key under it. */
export function keysUnderServer(map: ServerMap, url: string, account?: string): string[] {
  const base = normalizeServerUrl(url);
  return Object.keys(map.servers).filter((k) => {
    const { scope, account: own } = splitAccountKey(k);
    return own === account && (scope === base || scope.startsWith(`${base}/nests/`));
  });
}

/**
 * Every saved token of `account` that can open a server-level endpoint
 * (`<server>/mcp`): the server-wide key first, then each nest-scoped one. The
 * server accepts a nest-scoped key there and limits it to its nest, so a
 * server alias reaches a nest with only that nest's key saved. Empty for any
 * other endpoint (a single nest's `/nests/<id>/mcp` uses tokenForEndpoint).
 */
export function tokensForServerEndpoint(map: ServerMap, endpoint: string, account?: string): string[] {
  let target: string;
  try {
    target = normalizeServerUrl(endpoint);
  } catch {
    return [];
  }
  if (!target.endsWith("/mcp") || /\/nests\/[^/]+\/mcp$/.test(target)) return [];
  const server = target.slice(0, -"/mcp".length);
  const keys = keysUnderServer(map, server, account).sort((a, b) => Number(isNestScope(a)) - Number(isNestScope(b)));
  return [...new Set(keys.map((k) => map.servers[k].token))];
}

/** Token for `url` (exact server), or the default server when `url` is omitted. Null if none. */
export function tokenForServer(map: ServerMap, url?: string): string | null {
  const key = url ? normalizeServerUrl(url) : map.default;
  if (!key) return null;
  return map.servers[key]?.token ?? null;
}

/**
 * Token for an endpoint ON a saved server — e.g. `<server>/mcp` or
 * `<server>/nests/<id>/mcp` — by longest saved-server prefix. Matching is on
 * whole path segments, so `https://a.io/x` never lends its key to
 * `https://a.io/xy`, and never across origins.
 */
export function tokenForEndpoint(map: ServerMap, endpoint: string, account?: string): string | null {
  const key = keyForEndpoint(map, endpoint, account);
  return key ? map.servers[key].token : null;
}

/** The saved entry of `account` that `endpoint` authenticates with (see tokenForEndpoint), or null. */
export function keyForEndpoint(map: ServerMap, endpoint: string, account?: string): string | null {
  let target: string;
  try {
    target = normalizeServerUrl(endpoint);
  } catch {
    return null;
  }
  let best: string | null = null;
  for (const key of Object.keys(map.servers)) {
    const { scope, account: own } = splitAccountKey(key);
    if (own !== account) continue;
    if (target === scope || target.startsWith(`${scope}/`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best;
}

/**
 * Parse the stored map; junk entries are dropped. Unreadable or newer-format
 * data THROWS: treating it as empty would let the next `ctx login` save over
 * it and silently lose every other server's key.
 */
export function parseServerMap(json: string | null): ServerMap {
  if (!json) return emptyServerMap();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new CredentialStoreError(UNREADABLE_MAP);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new CredentialStoreError(UNREADABLE_MAP);
  const obj = data as Record<string, unknown>;
  if (typeof obj.version === "number" && obj.version > SERVER_MAP_VERSION) {
    throw new CredentialStoreError(
      `Saved \`ctx login\` keys were written by a newer ctx (format v${obj.version}). Upgrade ctx to use them.`,
    );
  }
  const raw =
    obj.servers && typeof obj.servers === "object" ? (obj.servers as Record<string, unknown>) : {};
  const servers: Record<string, ServerCredential> = {};
  for (const [url, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).token === "string") {
      const e = v as Record<string, unknown>;
      const cred: ServerCredential = { token: e.token as string };
      if (typeof e.label === "string") cred.label = e.label;
      if (typeof e.updatedAt === "string") cred.updatedAt = e.updatedAt;
      servers[url] = cred;
    }
  }
  const out: ServerMap = { version: typeof obj.version === "number" ? obj.version : 1, servers };
  if (typeof obj.default === "string" && servers[obj.default]) out.default = obj.default;
  return out;
}

const UNREADABLE_MAP =
  "Saved `ctx login` keys are unreadable (corrupt data). Nothing was changed. " +
  "Run `ctx logout --all` to reset, then log in again.";

// ─── Secure-store I/O ───────────────────────────────────────────────────────

/** The saved server map; empty when nothing is stored. Store errors propagate. */
export async function loadServerMap(opts: CredentialStoreOptions = {}): Promise<ServerMap> {
  return parseServerMap(await new CredentialStore(opts).get(SERVERS_ACCOUNT));
}

/**
 * Throws when a login could not be saved — no secure store, or a saved map that
 * can't be read — so `ctx login` fails before the server mints a key, not after.
 */
export async function assertServerMapWritable(opts: CredentialStoreOptions = {}): Promise<void> {
  if ((await new CredentialStore(opts).describe()).kind === "none") {
    throw new CredentialStoreError(NO_SECURE_STORE_HELP);
  }
  await loadServerMap(opts);
}

/** Persist the map securely. Returns where it went (e.g. "macOS Keychain"). */
export async function saveServerMap(map: ServerMap, opts: CredentialStoreOptions = {}): Promise<string> {
  const where = await new CredentialStore(opts).set(SERVERS_ACCOUNT, JSON.stringify(map));
  writeLoginState(map, opts);
  return where;
}

// ─── Login-state marker ─────────────────────────────────────────────────────
// Reading the store spawns a process (on Windows PowerShell + a C# compile,
// ~1 s), and every command against a key-less HTTP remote looks up a saved key.
// `<registry>/login-state` remembers, without the secret, whether any key is
// saved: "none" skips the read. No marker (fresh install, or keys saved by a
// ctx that predates it) means read once and write it. A ctx that predates it
// can still save keys behind a "none"; connectTarget re-reads `fresh` when the
// server then asks for a key, so that costs one read, never a lost login.

function loginStatePath(opts: CredentialStoreOptions): string {
  return pathMod.join(opts.home ? pathMod.join(opts.home, ".contextnest") : getRegistryDir(), "login-state");
}

function writeLoginState(map: ServerMap, opts: CredentialStoreOptions): void {
  writeLogins(map, opts); // always: the marker can stay "saved" while the server list changes
  const file = loginStatePath(opts);
  const state = Object.keys(map.servers).length > 0 ? "saved" : "none";
  try {
    if (fs.readFileSync(file, "utf-8") === state) return;
  } catch {
    // missing: write it
  }
  try {
    fs.mkdirSync(pathMod.dirname(file), { recursive: true });
    fs.writeFileSync(file, state);
  } catch {
    // Only a cache: without it the next lookup reads the store.
  }
}

// ─── Logged-in servers (non-secret) ─────────────────────────────────────────
// `<registry>/logins.json` lists the servers a server-wide key is saved for
// (URL and account only, never a key), so a command can tell "logged in but
// not registered" without opening the secure store. Written with the marker.

export interface LoginServerRef {
  url: string;
  account?: string;
}

function loginsPath(opts: CredentialStoreOptions): string {
  return pathMod.join(opts.home ? pathMod.join(opts.home, ".contextnest") : getRegistryDir(), "logins.json");
}

function serversOf(map: ServerMap): LoginServerRef[] {
  return Object.keys(map.servers)
    .filter((k) => !isNestScope(k))
    .map((k) => {
      const { scope, account } = splitAccountKey(k);
      return { url: scope, ...(account ? { account } : {}) };
    });
}

function writeLogins(map: ServerMap, opts: CredentialStoreOptions): void {
  const file = loginsPath(opts);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ version: 1, servers: serversOf(map) });
  try {
    if (fs.readFileSync(file, "utf-8") === body) return;
  } catch {
    // missing: write it
  }
  try {
    fs.mkdirSync(pathMod.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, body, { mode: 0o600 }); // account names can be emails
    fs.renameSync(tmp, file);
  } catch {
    // Only a cache: without it the next check reads the store once.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean
    }
  }
}

function readLogins(opts: CredentialStoreOptions): LoginServerRef[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(loginsPath(opts), "utf-8")) as { servers?: unknown };
    if (!Array.isArray(raw.servers)) return null;
    return raw.servers.filter(
      (s): s is LoginServerRef => !!s && typeof (s as LoginServerRef).url === "string",
    );
  } catch {
    return null;
  }
}

/**
 * The servers a server-wide key is saved for. Reads the plain file; only a
 * ctx that predates it (no file, marker not "none") opens the store, once,
 * and writes the file so the next call is free.
 */
export async function loggedInServers(opts: CredentialStoreOptions & { fileOnly?: boolean } = {}): Promise<LoginServerRef[]> {
  const cached = readLogins(opts);
  if (cached) return cached;
  if (opts.fileOnly) return [];
  if (nothingSaved(opts)) return [];
  try {
    return serversOf(await readSavedMap({ ...opts, fresh: true }));
  } catch {
    // An unreadable store (locked keychain, wrong key) is reported by the commands that need a key,
    // not by a hint. Remember "nothing known" so the next command doesn't open the store again;
    // the next successful save or read rewrites the file.
    writeLogins(emptyServerMap(), opts);
    return [];
  }
}

function nothingSaved(opts: CredentialStoreOptions): boolean {
  try {
    return fs.readFileSync(loginStatePath(opts), "utf-8").trim() === "none";
  } catch {
    return false;
  }
}

/**
 * A lookup's options. `fresh` reads the store even when the marker says nothing
 * is saved — for rare commands (`ctx push`) where a stale marker must not read
 * as "not logged in".
 */
export type SavedLookupOptions = CredentialStoreOptions & { fresh?: boolean };

/**
 * The saved token for `endpoint`, or null when nothing is saved for it. A store
 * that holds keys but can't be read (locked keyring, missing or wrong
 * CONTEXTNEST_CREDENTIALS_KEY, corrupt file) throws with the reason — it must
 * not masquerade as "not logged in".
 */
export async function savedTokenFor(
  endpoint: string,
  opts: SavedLookupOptions = {},
  account?: string,
): Promise<string | null> {
  return tokenForEndpoint(await readSavedMap(opts), endpoint, account);
}

/** Every saved token that opens the server-level `endpoint` (see tokensForServerEndpoint). */
export async function savedTokensForServer(
  endpoint: string,
  account?: string,
  opts: SavedLookupOptions = {},
): Promise<string[]> {
  return tokensForServerEndpoint(await readSavedMap(opts), endpoint, account);
}

async function readSavedMap(opts: SavedLookupOptions): Promise<ServerMap> {
  if (!opts.fresh && nothingSaved(opts)) return emptyServerMap();
  let json: string | null;
  try {
    json = await new CredentialStore(opts).get(SERVERS_ACCOUNT);
  } catch (err) {
    throw new CredentialStoreError(`Saved \`ctx login\` keys exist but couldn't be read: ${(err as Error).message}`);
  }
  const map = parseServerMap(json);
  writeLoginState(map, opts);
  return map;
}
