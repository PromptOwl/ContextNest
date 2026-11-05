/**
 * login-registry.ts — pure helpers that tie `ctx login` to the vault registry:
 * the alias a server is registered under, the exact command that signs in to a
 * remote again, and the "logged in but not registered" hint decision.
 * No IO here (the hint's two small files live in hints.ts), so every rule is a
 * plain unit test.
 */
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";
import { ALIAS_PATTERN } from "@promptowl/contextnest-engine";

type HttpRemote = Extract<RemoteNestSpec, { transport: "http" }>;

/** A server a key is saved for (the key itself is never part of this). */
export interface LoginServer {
  /** Normalized server origin, e.g. `https://nest.promptowl.ai`. */
  url: string;
  account?: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** `/mcp` or `/nests/<id>/mcp` stripped: the server origin an endpoint belongs to. */
export function serverOrigin(endpoint: string): string {
  const u = new URL(endpoint);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/nests\/[^/]+\/mcp\/?$/, "").replace(/\/mcp\/?$/, "");
  return u.toString().replace(/\/+$/, "");
}

/** The nest id in a `/nests/<id>/mcp` endpoint, if it names one. */
export function nestIdOf(endpoint: string): string | undefined {
  const m = /\/nests\/([^/]+)\/mcp\/?$/.exec(new URL(endpoint).pathname);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * What an endpoint URL proves: `/nests/<id>/mcp` is one nest. A bare `/mcp` is also
 * the path of a self-hosted single-nest server, so it proves nothing: the probe decides.
 */
export function scopeForEndpoint(endpoint: string): "nest" | undefined {
  try {
    return /\/nests\/[^/]+\/mcp\/?$/.test(new URL(endpoint).pathname) ? "nest" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The alias a server registers under when the user gave none: its brand label
 * (`nest.promptowl.ai` → `promptowl`). A bare IP or `localhost` has no brand,
 * so the host and port stand in (`localhost-3737`). `taken` says which names
 * are in use; a collision gets `-2`, `-3`, …
 */
export function deriveServerAlias(serverUrl: string, taken: (alias: string) => boolean): string {
  const u = new URL(serverUrl);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let base: string;
  if (IPV4.test(host) || host.includes(":") || host === "localhost") {
    base = [host, u.port].filter(Boolean).join("-");
  } else {
    base = host.replace(/^(nest|www|api)\./, "").split(".")[0];
  }
  base = base.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "nest";
  let alias = base;
  for (let n = 2; taken(alias) || !ALIAS_PATTERN.test(alias); n++) alias = `${base}-${n}`;
  return alias;
}

/**
 * The exact command that signs in again for a remote, in place of a `<server>`
 * placeholder. A nest-scoped endpoint (or a `<server>/<nest>` call that used a
 * nest key) needs the nest's own key, pasted.
 */
export function loginCommandFor(spec: Pick<HttpRemote, "url" | "account">, nestId?: string): string {
  const account = spec.account ? ` --account ${spec.account}` : "";
  const nest = nestId ?? nestIdOf(spec.url);
  const origin = serverOrigin(spec.url);
  return nest
    ? `ctx login ${origin} --nest ${nest}${account} --key-stdin`
    : `ctx login ${origin}${account}`;
}

/** True when `remote` signs in with a `ctx login` key for `server` (any scope: server or one nest). */
function coversLogin(remote: RemoteNestSpec, server: LoginServer): boolean {
  if (remote.transport !== "http" || remote.auth) return false;
  if ((remote.account ?? undefined) !== (server.account ?? undefined)) return false;
  try {
    return serverOrigin(remote.url) === server.url;
  } catch {
    return false;
  }
}

/** True when `remote` stands for the whole server: a nest-scoped remote leaves the others unlisted. */
export function coversServer(remote: RemoteNestSpec, server: LoginServer): boolean {
  if (remote.transport !== "http" || remote.scope === "nest") return false;
  try {
    return !nestIdOf(remote.url) && coversLogin(remote, server);
  } catch {
    return false;
  }
}

/** Aliases whose remote signs in with the key saved for `server`. */
export function aliasesFor(remotes: Record<string, RemoteNestSpec> | undefined, server: LoginServer): string[] {
  return Object.entries(remotes ?? {})
    .filter(([, r]) => coversLogin(r, server))
    .map(([alias]) => alias);
}

/** Logged-in servers no registry remote stands for (a lone nest remote doesn't). */
export function unregisteredLogins(logins: LoginServer[], remotes: Record<string, RemoteNestSpec> | undefined): LoginServer[] {
  const all = Object.values(remotes ?? {});
  return logins.filter((l) => !all.some((r) => coversServer(r, l)));
}

/** Commands that settle, or are about, the registration; the hint would only repeat them. */
const HINT_QUIET_COMMANDS = new Set(["login", "logout", "vault add", "vault remove", "vault rename", "hints", "hints on", "hints off"]);

export interface HintContext {
  /** stderr is a terminal: a person is reading, not an agent or CI capturing a pipe. */
  stderrIsTTY: boolean;
  /** The command prints machine-readable output. */
  json: boolean;
  command: string;
  env: Record<string, string | undefined>;
  /** `ctx hints off` was run. */
  disabled: boolean;
}

/** Whether the "logged in but not registered" hint may print for this run. */
export function mayShowLoginHint(ctx: HintContext): boolean {
  if (ctx.disabled || ctx.json || !ctx.stderrIsTTY) return false;
  if (ctx.env.CONTEXTNEST_NO_HINTS && ctx.env.CONTEXTNEST_NO_HINTS !== "0") return false;
  if (ctx.env.CI) return false;
  return !HINT_QUIET_COMMANDS.has(ctx.command);
}

/** The one-line hint for a logged-in, unregistered server; names the command that fixes it. */
export function loginHintLine(server: LoginServer, alias: string): string {
  const account = server.account ? ` --account ${server.account}` : "";
  return (
    `ctx: logged in to ${server.url} but no vault is registered for it — ` +
    `run: ctx vault add ${alias} --url ${server.url}/mcp --server${account}   (silence: ctx hints off)`
  );
}

/** A registered alias given to `ctx login` in place of a URL: where it signs in, and as whom. */
export function loginTargetOfAlias(
  arg: string,
  remotes: Record<string, RemoteNestSpec> | undefined,
): { server: string; account?: string; nest?: string } | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return null;
  const spec = remotes?.[arg];
  // An alias with its own credential (bearer_env) never uses a `ctx login` key.
  if (!spec || spec.transport !== "http" || spec.auth) return null;
  const nest = nestIdOf(spec.url);
  return { server: serverOrigin(spec.url), ...(spec.account ? { account: spec.account } : {}), ...(nest ? { nest } : {}) };
}
