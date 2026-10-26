import { describe, it, expect, vi } from "vitest";
import { ContextNestError, type RemoteNestSpec } from "@promptowl/contextnest-engine";
import { LoginError, NoBrowserLoginError, deviceLogin, parsePastedKey, resolvePushKey } from "../login.js";
import { LOGIN_TOKEN_ENV, connectTarget, wantsLoginKey } from "../remote.js";

const SERVER = "https://nest.example.com";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string | string[]> } | Error;

/** A scripted fetch: each path pops its next reply; every request is recorded. */
function scriptedFetch(script: Record<string, Reply[]>) {
  const calls: { path: string; url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, url: String(url), init });
    const next = script[path]?.shift();
    if (!next) throw new Error(`unexpected request ${path}`);
    if (next instanceof Error) throw next;
    const h = new Headers();
    for (const [k, v] of Object.entries(next.headers ?? {})) {
      for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
    }
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, { status: next.status ?? 200, headers: h });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const START = { body: { deviceCode: "dc", clientSecret: "cs", verificationUrl: "https://po.example/approve", userCode: "AB" } };
const APPROVED = { body: { status: "approved", token: "po_tok" } };
const PENDING = { body: { status: "pending" } };
const EXCHANGE = {
  body: { user: { email: "me@example.com" } },
  headers: { "set-cookie": ["cn_session=s1; HttpOnly; Path=/", "po_marker=1; Path=/"] },
};
const MINT = { status: 201, body: { api_key: "cnst_minted" } };

function io(f: ReturnType<typeof scriptedFetch>, extra: Partial<Parameters<typeof deviceLogin>[1]> = {}) {
  let t = 0;
  return { fetch: f.fetch, sleep: async (ms: number) => void (t += ms), now: () => t, deviceName: "ctx CLI (box)", ...extra };
}

describe("deviceLogin", () => {
  it("approves, exchanges the token for a session, and mints a labelled key with that cookie", async () => {
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [PENDING, APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [MINT],
    });
    const prompt = vi.fn();
    const res = await deviceLogin(SERVER, io(f, { prompt }));
    expect(res).toEqual({ token: "cnst_minted", email: "me@example.com", keyLabel: "ctx CLI (box)" });
    expect(prompt).toHaveBeenCalledWith("https://po.example/approve", "AB");
    const mint = f.calls.find((c) => c.path === "/auth/keys")!;
    expect((mint.init.headers as Record<string, string>).Cookie).toBe("cn_session=s1; po_marker=1");
    expect(JSON.parse(String(mint.init.body))).toEqual({ label: "ctx CLI (box)" });
    // No hop may follow a redirect: every request is sent with redirect: "manual".
    expect(f.calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("polls with the device secret in a POST body, never in the URL", async () => {
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [PENDING, APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [MINT],
    });
    await deviceLogin(SERVER, io(f));
    const polls = f.calls.filter((c) => c.path === "/auth/device/poll");
    expect(polls).toHaveLength(2);
    for (const p of polls) {
      expect(p.init.method).toBe("POST");
      expect(p.url).toBe(`${SERVER}/auth/device/poll`);
      expect(JSON.parse(String(p.init.body))).toEqual({ code: "dc", client_secret: "cs" });
    }
  });

  it("falls back to the GET poll once on a server without POST /auth/device/poll", async () => {
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [{ status: 404 }, PENDING, APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [MINT],
    });
    const res = await deviceLogin(SERVER, io(f));
    expect(res.token).toBe("cnst_minted");
    const polls = f.calls.filter((c) => c.path === "/auth/device/poll");
    // One POST, then GET for the rest of the login — no POST retried every tick.
    expect(polls.map((p) => p.init.method ?? "GET")).toEqual(["POST", "GET", "GET"]);
    expect(polls[1].url).toBe(`${SERVER}/auth/device/poll?code=dc&client_secret=cs`);
  });

  it("refuses a redirect instead of carrying the session cookie to another host", async () => {
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [{ status: 302, headers: { location: "https://evil.example/keys" } }],
    });
    await expect(deviceLogin(SERVER, io(f))).rejects.toThrow(/redirected.*evil\.example/);

    // A redirected poll is refused outright, not retried as a transient failure.
    const poll = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [{ status: 302, headers: { location: "https://evil.example/poll" } }, APPROVED],
    });
    await expect(deviceLogin(SERVER, io(poll))).rejects.toThrow(/redirected.*evil\.example/);
  });

  it("says browser login is unavailable and points at --key-stdin", async () => {
    const f = scriptedFetch({ "/auth/device": [{ status: 403, body: { error: "PromptOwl sign-in is restricted" } }] });
    await expect(deviceLogin(SERVER, io(f))).rejects.toThrow(/403: PromptOwl sign-in is restricted[\s\S]*--key-stdin/);
    // Typed, so `ctx login` can fall back to a pasted key on a terminal.
    const again = scriptedFetch({ "/auth/device": [{ status: 404 }] });
    await expect(deviceLogin(SERVER, io(again))).rejects.toBeInstanceOf(NoBrowserLoginError);
  });

  it("stops on a denied approval", async () => {
    const f = scriptedFetch({ "/auth/device": [START], "/auth/device/poll": [{ body: { status: "denied" } }] });
    await expect(deviceLogin(SERVER, io(f))).rejects.toThrow("Login denied");
  });

  it("rides out transient poll failures, then gives up after repeated ones", async () => {
    const ok = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [new Error("ECONNRESET"), { status: 502, body: "<html>" }, { body: "not json" }, APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [MINT],
    });
    expect((await deviceLogin(SERVER, io(ok))).token).toBe("cnst_minted");

    const down = scriptedFetch({ "/auth/device": [START], "/auth/device/poll": Array(6).fill({ status: 503 }) });
    await expect(deviceLogin(SERVER, io(down))).rejects.toThrow(/Lost contact/);
  });

  it("honours the server's interval and expiry", async () => {
    const f = scriptedFetch({
      "/auth/device": [{ body: { ...START.body, interval: 5, expiresIn: 12 } }],
      "/auth/device/poll": [PENDING, PENDING, PENDING],
    });
    const sleeps: number[] = [];
    let t = 0;
    await expect(
      deviceLogin(SERVER, { fetch: f.fetch, now: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += ms)) }),
    ).rejects.toThrow(/timed out/);
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it("a repeat login from the same machine mints the first free '<label> #N' instead of failing", async () => {
    const dup = { status: 409, body: { error: 'You already have a key named "ctx CLI (box)".' } };
    const list = { body: { keys: [{ label: "ctx CLI (box)" }, { label: "CTX CLI (box) #2 " }, { label: "other" }] } };
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [dup, list, MINT],
    });
    const res = await deviceLogin(SERVER, io(f));
    expect(res).toMatchObject({ token: "cnst_minted", keyLabel: "ctx CLI (box) #3" });
    const minted = f.calls.filter((c) => c.path === "/auth/keys" && c.init.method === "POST");
    expect(minted.map((c) => JSON.parse(String(c.init.body)).label)).toEqual(["ctx CLI (box)", "ctx CLI (box) #3"]);
  });

  it("reports a 409 that isn't a taken label (the key limit) as the server worded it, without retrying", async () => {
    const limit = { status: 409, body: { error: "You already have 25 API keys. Revoke one before creating another." } };
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [limit, { body: { keys: [{ label: "something else" }] } }],
    });
    await expect(deviceLogin(SERVER, io(f))).rejects.toThrow(/409: You already have 25 API keys/);
    expect(f.calls.filter((c) => c.path === "/auth/keys" && c.init.method === "POST")).toHaveLength(1);
  });

  it("keeps the key label within the server's 60-character cap, suffix included", async () => {
    const long = `ctx CLI (${"h".repeat(80)})`;
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [{ status: 409, body: {} }, { body: { keys: [{ label: long.slice(0, 60) }] } }, MINT],
    });
    const { keyLabel } = await deviceLogin(SERVER, io(f, { deviceName: long }));
    expect(keyLabel.length).toBe(60);
    expect(keyLabel.endsWith(" #2")).toBe(true);
  });

  it("refuses to show or open a verification link that isn't plain http(s)", async () => {
    for (const bad of [
      { verificationUrl: "file:///etc/passwd" },
      { verificationUrl: "javascript:alert(1)" },
      { verificationUrl: "https://po.example/\u001b]8;;evil\u0007" },
      { userCode: "AB\u001b[2J" },
    ]) {
      const prompt = vi.fn();
      const f = scriptedFetch({ "/auth/device": [{ body: { ...START.body, ...bad } }] });
      await expect(deviceLogin(SERVER, io(f, { prompt }))).rejects.toThrow(/unsafe verification link/);
      expect(prompt).not.toHaveBeenCalled();
    }
  });

  it("fails clearly when the exchange sets no session cookie or the mint returns no key", async () => {
    const noCookie = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [{ body: {} }],
    });
    await expect(deviceLogin(SERVER, io(noCookie))).rejects.toThrow(/session cookie/);

    const noKey = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [{ status: 201, body: {} }],
    });
    await expect(deviceLogin(SERVER, io(noKey))).rejects.toThrow(LoginError);
  });
});

describe("parsePastedKey", () => {
  it("strips wrapped whitespace and requires the cnst_ shape", () => {
    expect(parsePastedKey("  cnst_ab\ncd \r\n")).toBe("cnst_abcd");
    expect(() => parsePastedKey("")).toThrow(/No key/);
    expect(() => parsePastedKey("po_live_xyz")).toThrow(/cnst_/);
  });
});

describe("resolvePushKey", () => {
  it("prefers --key, then CONTEXTNEST_API_KEY, then the saved login key", async () => {
    const saved = vi.fn(async () => "cnst_saved");
    expect(await resolvePushKey("cnst_flag", { CONTEXTNEST_API_KEY: "cnst_env" }, saved)).toBe("cnst_flag");
    expect(await resolvePushKey(undefined, { CONTEXTNEST_API_KEY: "cnst_env" }, saved)).toBe("cnst_env");
    expect(saved).not.toHaveBeenCalled();
    expect(await resolvePushKey(undefined, {}, saved)).toBe("cnst_saved");
  });

  it("never consults a broken store when a key was given explicitly", async () => {
    const broken = async () => {
      throw new Error("keyring locked");
    };
    expect(await resolvePushKey("cnst_flag", {}, broken)).toBe("cnst_flag");
    await expect(resolvePushKey(undefined, {}, broken)).rejects.toThrow("keyring locked");
  });
});

describe("connectTarget", () => {
  const http: RemoteNestSpec = { transport: "http", url: `${SERVER}/mcp` };
  const conn = { run: vi.fn(), toolNames: vi.fn(), close: vi.fn() };

  it("only borrows the login key for an HTTP remote with no auth", () => {
    expect(wantsLoginKey(http)).toBe(true);
    expect(wantsLoginKey({ ...http, auth: { bearer_env: "MY_KEY" } })).toBe(false);
    expect(wantsLoginKey({ transport: "stdio", command: "x" } as RemoteNestSpec)).toBe(false);
  });

  it("hands the saved key to the engine as a bearer", async () => {
    const connect = vi.fn(async () => conn);
    await connectTarget({ alias: "h", spec: http }, async () => "cnst_saved", connect as never);
    const [, spec, env] = connect.mock.calls[0] as unknown as [string, RemoteNestSpec, Record<string, string>];
    expect(spec).toMatchObject({ auth: { bearer_env: LOGIN_TOKEN_ENV } });
    expect(env[LOGIN_TOKEN_ENV]).toBe("cnst_saved");
  });

  it("looks up the named nest's key, under the alias's account, for a server alias naming one nest", async () => {
    const connect = vi.fn(async () => conn);
    const lookup = vi.fn(async () => "cnst_nest");
    await connectTarget({ alias: "h/n", spec: { ...http, account: "client" }, nest: "n" }, lookup, connect as never, "id/1");
    expect(lookup).toHaveBeenCalledWith(`${SERVER}/nests/id%2F1`, "client");
    const [, spec, env] = connect.mock.calls[0] as unknown as [string, RemoteNestSpec, Record<string, string>];
    // The server endpoint, not the nest's own: the server limits the key to its nest.
    expect(spec).toMatchObject({ url: `${SERVER}/mcp` });
    expect(env[LOGIN_TOKEN_ENV]).toBe("cnst_nest");
  });

  it("leaves explicit registry auth alone and never reads the store for it", async () => {
    const connect = vi.fn(async () => conn);
    const lookup = vi.fn(async () => "cnst_saved");
    const spec = { ...http, auth: { bearer_env: "MY_KEY" } };
    await connectTarget({ alias: "h", spec }, lookup, connect as never);
    expect(lookup).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith("h", spec);
  });

  it("names the plural /nests/ path when a singular /nest/<id>/mcp is unreachable, keeping the exit code", async () => {
    const unreachable = vi.fn(async () => {
      throw new ContextNestError('Remote nest "h" is unreachable — {"error":"Not found"}', "REMOTE_UNREACHABLE");
    });
    const typo: RemoteNestSpec = { transport: "http", url: `${SERVER}/nest/abc/mcp`, auth: { bearer_env: "K" } };
    await expect(connectTarget({ alias: "h", spec: typo }, async () => null, unreachable as never)).rejects.toMatchObject({
      code: "REMOTE_UNREACHABLE",
      message: expect.stringContaining(`did you mean ${SERVER}/nests/abc/mcp`),
    });
    const right: RemoteNestSpec = { transport: "http", url: `${SERVER}/nests/abc/mcp` };
    const err = await connectTarget({ alias: "h", spec: right }, async () => null, unreachable as never).catch((e) => e);
    expect((err as Error).message).not.toContain("did you mean");
  });

  it("rewrites an auth failure to point at ctx login", async () => {
    const reject = vi.fn(async () => {
      throw new ContextNestError("rejected — Check that CONTEXTNEST_LOGIN_TOKEN is exported", "REMOTE_AUTH_FAILED");
    });
    await expect(connectTarget({ alias: "h", spec: http }, async () => "cnst_old", reject as never)).rejects.toThrow(
      /ctx login <server>` again/,
    );
  });

  it("when the server asks for a key the cached lookup missed, reads the store fresh once and signs in", async () => {
    const lookup = vi.fn(async (_url: string, _account?: string, fresh?: boolean) => (fresh ? "cnst_saved" : null));
    const connect = vi.fn(async (_alias: string, spec: RemoteNestSpec) => {
      if (spec.transport === "http" && !spec.auth) throw new ContextNestError("no auth configured", "REMOTE_AUTH_FAILED");
      return conn;
    });
    await expect(connectTarget({ alias: "h", spec: http }, lookup, connect as never)).resolves.toBe(conn);
    expect(lookup).toHaveBeenLastCalledWith(`${SERVER}/mcp`, undefined, true);
    const [, , env] = connect.mock.calls[1] as unknown as [string, RemoteNestSpec, Record<string, string>];
    expect(env[LOGIN_TOKEN_ENV]).toBe("cnst_saved");
  });

  it("an unreadable store never blocks a remote that needs no key; it surfaces only when the server asks for one", async () => {
    const unreadable = async () => {
      throw new Error("Saved `ctx login` keys exist but couldn't be read: wrong key");
    };
    const open = vi.fn(async () => conn);
    await expect(connectTarget({ alias: "h", spec: http }, unreadable, open as never)).resolves.toBe(conn);
    expect(open).toHaveBeenCalledWith("h", http);

    const reject = vi.fn(async () => {
      throw new ContextNestError("no auth configured", "REMOTE_AUTH_FAILED");
    });
    await expect(connectTarget({ alias: "h", spec: http }, unreadable, reject as never)).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringMatching(/couldn't be read/),
    });
    // Nothing saved and the server wants a key: point at ctx login.
    await expect(connectTarget({ alias: "h", spec: http }, async () => null, reject as never)).rejects.toMatchObject({
      code: "REMOTE_AUTH_FAILED",
      message: expect.stringMatching(/ctx login <server>.*--vault h\/<nest>/),
    });
    // A single-nest endpoint has no /<nest> to name.
    const one: RemoteNestSpec = { transport: "http", url: `${SERVER}/nests/abc/mcp` };
    const err = await connectTarget({ alias: "h", spec: one }, async () => null, reject as never).catch((e) => e);
    expect((err as Error).message).not.toContain("--vault h/<nest>");
  });
});
