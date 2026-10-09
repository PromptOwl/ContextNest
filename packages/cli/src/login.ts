/**
 * login.ts — the network half of `ctx login`: browser (device) sign-in against
 * a Community server, and the key-precedence rules `push` and remote aliases
 * share. I/O is injected so every branch is unit-tested (login.test.ts).
 *
 * Device flow, the same one the web UI's "Sign in with PromptOwl" drives:
 *   POST /auth/device → poll GET /auth/device/poll → POST /auth/promptowl
 *   (session cookie) → POST /auth/keys (mint a key labelled for this machine).
 * Accounts hold several keys, so this never replaces one already in use.
 */
import { NO_REDIRECT, assertNotRedirected } from "./safety.js";

/** Per-request ceiling; a hung server must not hang the CLI. */
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_S = 2;
/** Give up waiting for approval after this long unless the server says otherwise. */
const DEFAULT_EXPIRES_S = 600;
/** Consecutive transient poll failures (network, 5xx, non-JSON) tolerated. */
const MAX_POLL_RETRIES = 5;

export interface DeviceLoginIO {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Show the approval URL (and open a browser). */
  prompt?: (verificationUrl: string, userCode?: string) => void;
  deviceName?: string;
}

export interface DeviceLoginResult {
  token: string;
  /** Signed-in account email, when the server reports it. */
  email?: string;
  /** Label the minted key carries on the server (what to revoke). */
  keyLabel: string;
}

export class LoginError extends Error {
  override name = "LoginError";
}

class TransientError extends Error {}

async function errorText(res: Response): Promise<string> {
  const e = (await res.json().catch(() => ({}))) as { error?: string };
  return `${res.status}${e.error ? `: ${e.error}` : ""}`;
}

export async function deviceLogin(serverUrl: string, io: DeviceLoginIO = {}): Promise<DeviceLoginResult> {
  const doFetch = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  const keyLabel = io.deviceName ?? "ctx CLI";

  // Every hop carries a secret (device secret, PromptOwl token, session cookie),
  // so none may follow a redirect to an unvalidated host — same rule as push.
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await doFetch(`${serverUrl}${path}`, {
      ...NO_REDIRECT,
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assertNotRedirected(res, "The server");
    return res;
  };
  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  const startRes = await postJson("/auth/device", { deviceName: keyLabel });
  if (!startRes.ok) {
    throw new LoginError(
      `This server doesn't offer browser login (${await errorText(startRes)}).\n` +
        `  Paste a key instead: ctx login ${serverUrl} --key-stdin  (create one in the web UI → Connect)`,
    );
  }
  const start = (await startRes.json().catch(() => ({}))) as {
    deviceCode?: string;
    clientSecret?: string;
    verificationUrl?: string;
    userCode?: string;
    interval?: number;
    expiresIn?: number;
    expires_in?: number;
  };
  if (!start.deviceCode || !start.clientSecret || !start.verificationUrl) {
    throw new LoginError("Server returned an incomplete device-login response.");
  }
  io.prompt?.(start.verificationUrl, start.userCode);

  const intervalMs = Math.max(1, start.interval ?? DEFAULT_POLL_INTERVAL_S) * 1000;
  const deadline = now() + (start.expiresIn ?? start.expires_in ?? DEFAULT_EXPIRES_S) * 1000;
  const pollPath =
    `/auth/device/poll?code=${encodeURIComponent(start.deviceCode)}` +
    `&client_secret=${encodeURIComponent(start.clientSecret)}`;

  let poToken: string | null = null;
  let failures = 0;
  while (!poToken) {
    if (now() >= deadline) throw new LoginError("Login timed out waiting for approval.");
    await sleep(intervalMs);
    try {
      let res: Response;
      try {
        res = await call(pollPath);
      } catch (err) {
        if ((err as Error).message.includes("redirected")) throw err;
        throw new TransientError((err as Error).message);
      }
      if (res.status >= 500) throw new TransientError(`server error ${res.status}`);
      const pd = (await res.json().catch(() => null)) as { status?: string; token?: string; error?: string } | null;
      if (!pd) throw new TransientError(`unreadable poll response (${res.status})`);
      failures = 0;
      if (pd.status === "approved" && pd.token) poToken = pd.token;
      else if (pd.status !== "pending") {
        throw new LoginError(`Login ${pd.status || pd.error || `failed (${res.status})`}. Try again.`);
      }
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
      if (++failures > MAX_POLL_RETRIES) {
        throw new LoginError(`Lost contact with the server while waiting for approval (${err.message}).`);
      }
    }
  }

  // Exchange the PromptOwl token for a session on this server, keeping the cookie.
  const exRes = await postJson("/auth/promptowl", { token: poToken });
  if (!exRes.ok) throw new LoginError(`Sign-in was refused (${await errorText(exRes)}).`);
  const cookie = exRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new LoginError("Server did not return a session cookie.");
  const ex = (await exRes.json().catch(() => ({}))) as { user?: { email?: string } };

  const mintRes = await postJson("/auth/keys", { label: keyLabel }, { Cookie: cookie });
  if (!mintRes.ok) throw new LoginError(`Could not create an API key (${await errorText(mintRes)}).`);
  const minted = (await mintRes.json().catch(() => ({}))) as { api_key?: string };
  if (!minted.api_key) throw new LoginError("Server did not return an API key.");
  return { token: minted.api_key, keyLabel, ...(ex.user?.email ? { email: ex.user.email } : {}) };
}

/**
 * Normalize a pasted key: drop ALL whitespace (terminals wrap long pastes) and
 * insist on the `cnst_` shape so a PromptOwl token or a stray line can't be
 * saved as a server key.
 */
export function parsePastedKey(raw: string): string {
  const key = raw.replace(/\s+/g, "");
  if (!key) throw new LoginError("No key on stdin.");
  if (!/^cnst_[A-Za-z0-9_-]+$/.test(key)) {
    throw new LoginError("That doesn't look like a ContextNest API key (expected cnst_…).");
  }
  return key;
}

/**
 * Which key `push` sends: --key, then CONTEXTNEST_API_KEY, then the `ctx login`
 * key. `saved` is only consulted when the first two are absent, so a broken
 * secure store never blocks an explicit key.
 */
export async function resolvePushKey(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  saved: () => Promise<string | null>,
): Promise<string | null> {
  return flag || env.CONTEXTNEST_API_KEY || (await saved());
}
