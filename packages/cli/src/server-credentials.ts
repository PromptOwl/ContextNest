/**
 * server-credentials.ts — API keys saved by `ctx login`, one per ContextNest
 * server, so `ctx push` and remote `--vault` aliases stop asking for a key.
 *
 * The map of servers is pure data (unit-tested in server-credentials.test.ts).
 * It is persisted as ONE secret in the secure credential store
 * (credentials.ts: OS keyring, else the encrypted file) — never plaintext.
 * Keyed by normalized server URL so one machine can hold keys for several
 * servers at once (hosted + self-hosted + a client's).
 *
 * Writes are read-modify-write on that one secret and not locked: two
 * `ctx login` runs finishing at the same instant can drop one entry (re-run
 * it). Logins are interactive and rare, so a lock isn't worth its failure modes.
 */
import { CredentialStore, CredentialStoreError, type CredentialStoreOptions } from "./credentials.js";

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

/** Add or replace the credential for `url`. The first server added becomes the default. */
export function upsertServer(map: ServerMap, url: string, cred: ServerCredential): ServerMap {
  const key = normalizeServerUrl(url);
  return {
    version: map.version || 1,
    default: map.default ?? key,
    servers: { ...map.servers, [key]: cred },
  };
}

/** Remove `url`. If it was the default, promote the next remaining server (or clear). */
export function removeServer(map: ServerMap, url: string): ServerMap {
  const key = normalizeServerUrl(url);
  const servers = { ...map.servers };
  delete servers[key];
  let def = map.default;
  if (def === key) def = Object.keys(servers)[0];
  return { version: map.version || 1, servers, ...(def ? { default: def } : {}) };
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
export function tokenForEndpoint(map: ServerMap, endpoint: string): string | null {
  let target: string;
  try {
    target = normalizeServerUrl(endpoint);
  } catch {
    return null;
  }
  let best: string | null = null;
  for (const key of Object.keys(map.servers)) {
    if (target === key || target.startsWith(`${key}/`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? map.servers[best].token : null;
}

/** Defensive parse: anything malformed collapses to an empty map; junk entries are dropped. */
export function parseServerMap(json: string | null): ServerMap {
  if (!json) return emptyServerMap();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return emptyServerMap();
  }
  if (!data || typeof data !== "object") return emptyServerMap();
  const obj = data as Record<string, unknown>;
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

// ─── Secure-store I/O ───────────────────────────────────────────────────────

/** The saved server map; empty when nothing is stored. Store errors propagate. */
export async function loadServerMap(opts: CredentialStoreOptions = {}): Promise<ServerMap> {
  return parseServerMap(await new CredentialStore(opts).get(SERVERS_ACCOUNT));
}

/** Persist the map securely. Returns where it went (e.g. "macOS Keychain"). */
export async function saveServerMap(map: ServerMap, opts: CredentialStoreOptions = {}): Promise<string> {
  return new CredentialStore(opts).set(SERVERS_ACCOUNT, JSON.stringify(map));
}

/**
 * The saved token for `endpoint`, or null when nothing is saved for it. A store
 * that holds keys but can't be read (locked keyring, missing or wrong
 * CONTEXTNEST_CREDENTIALS_KEY, corrupt file) throws with the reason — it must
 * not masquerade as "not logged in".
 */
export async function savedTokenFor(endpoint: string, opts: CredentialStoreOptions = {}): Promise<string | null> {
  let map: ServerMap;
  try {
    map = await loadServerMap(opts);
  } catch (err) {
    throw new CredentialStoreError(`Saved \`ctx login\` keys exist but couldn't be read: ${(err as Error).message}`);
  }
  return tokenForEndpoint(map, endpoint);
}
