/**
 * CLI credential store — caches a per-server API token so `ctx login` is a
 * one-time thing and commands like `ctx push` stop re-asking for `--key`.
 *
 * Pure data-model here (framework-free, unit-tested in credentials.test.ts);
 * the small filesystem I/O (read/write `~/.contextnest/credentials.json`,
 * owner-only) lives at the bottom and is the only impure part. Keyed by
 * normalized server URL so one machine can hold creds for several nest
 * servers at once (cloud + self-hosted + a client's), like AWS named profiles.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";

export interface ServerCredential {
  /** Bearer token (a `cnst_…` API key) for this server. */
  token: string;
  /** Optional human label — typically the signed-in account email. */
  label?: string;
  /** ISO timestamp the credential was stored/refreshed. */
  updatedAt?: string;
}

export interface CredentialStore {
  version: number;
  /** Normalized URL of the default server (used when a command omits --server). */
  default?: string;
  /** Credentials keyed by normalized server URL. */
  servers: Record<string, ServerCredential>;
}

/**
 * Canonical form of a server URL: scheme + host lowercased (via WHATWG URL),
 * no trailing slash, no fragment. Throws for anything that isn't http(s) so a
 * typo can't silently key a credential under a garbage string.
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
  return u.toString().replace(/\/$/, "");
}

export function emptyStore(): CredentialStore {
  return { version: 1, servers: {} };
}

/** Add or replace the credential for `url`. The first server added becomes the default. */
export function upsertCredential(
  store: CredentialStore,
  url: string,
  cred: ServerCredential,
): CredentialStore {
  const key = normalizeServerUrl(url);
  const servers = { ...store.servers, [key]: cred };
  return {
    version: store.version || 1,
    default: store.default ?? key,
    servers,
  };
}

/** Remove `url`. If it was the default, promote the next remaining server (or clear). */
export function removeCredential(
  store: CredentialStore,
  url: string,
): CredentialStore {
  const key = normalizeServerUrl(url);
  const servers = { ...store.servers };
  delete servers[key];
  let def = store.default;
  if (def === key) def = Object.keys(servers)[0];
  const next: CredentialStore = { version: store.version || 1, servers };
  if (def) next.default = def;
  return next;
}

/** Token for `url` (normalized), or the default server when `url` is omitted. Null if none. */
export function resolveToken(
  store: CredentialStore,
  url?: string,
): string | null {
  const key = url ? normalizeServerUrl(url) : store.default;
  if (!key) return null;
  return store.servers[key]?.token ?? null;
}

/** Defensive parse: anything malformed collapses to an empty store; junk entries are dropped. */
export function parseStore(json: string | null): CredentialStore {
  if (!json) return emptyStore();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return emptyStore();
  }
  if (!data || typeof data !== "object") return emptyStore();
  const obj = data as Record<string, unknown>;
  const rawServers =
    obj.servers && typeof obj.servers === "object"
      ? (obj.servers as Record<string, unknown>)
      : {};
  const servers: Record<string, ServerCredential> = {};
  for (const [url, v] of Object.entries(rawServers)) {
    if (v && typeof v === "object" && typeof (v as any).token === "string") {
      const e = v as Record<string, unknown>;
      const cred: ServerCredential = { token: e.token as string };
      if (typeof e.label === "string") cred.label = e.label;
      if (typeof e.updatedAt === "string") cred.updatedAt = e.updatedAt;
      servers[url] = cred;
    }
  }
  const out: CredentialStore = {
    version: typeof obj.version === "number" ? obj.version : 1,
    servers,
  };
  if (typeof obj.default === "string" && servers[obj.default]) {
    out.default = obj.default;
  }
  return out;
}

export function serializeStore(store: CredentialStore): string {
  return JSON.stringify(store, null, 2);
}

// ─── Filesystem I/O (the only impure part) ──────────────────────────────────

export function getCredentialsPath(): string {
  return join(homedir(), ".contextnest", "credentials.json");
}

export function readCredentialStore(): CredentialStore {
  const path = getCredentialsPath();
  try {
    return parseStore(readFileSync(path, "utf-8"));
  } catch {
    return emptyStore();
  }
}

export function writeCredentialStore(store: CredentialStore): void {
  const dir = join(homedir(), ".contextnest");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = getCredentialsPath();
  writeFileSync(path, serializeStore(store), { mode: 0o600 });
  // Tighten perms even if the file pre-existed with looser bits — it holds
  // bearer tokens, so keep it owner-only.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}
