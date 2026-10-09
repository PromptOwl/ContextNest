import { describe, it, expect, vi } from "vitest";
import { ContextNestError, type RemoteNestSpec } from "@promptowl/contextnest-engine";
import { LoginError, deviceLogin, parsePastedKey, resolvePushKey } from "../login.js";
import { LOGIN_TOKEN_ENV, connectTarget, wantsLoginKey } from "../remote.js";

const SERVER = "https://nest.example.com";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string | string[]> } | Error;

/** A scripted fetch: each path pops its next reply; every request is recorded. */
function scriptedFetch(script: Record<string, Reply[]>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
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

  it("refuses a redirect instead of carrying the session cookie to another host", async () => {
    const f = scriptedFetch({
      "/auth/device": [START],
      "/auth/device/poll": [APPROVED],
      "/auth/promptowl": [EXCHANGE],
      "/auth/keys": [{ status: 302, headers: { location: "https://evil.example/keys" } }],
    });
    await expect(deviceLogin(SERVER, io(f))).rejects.toThrow(/redirected.*evil\.example/);
  });

  it("says browser login is unavailable and points at --key-stdin", async () => {
    const f = scriptedFetch({ "/auth/device": [{ status: 403, body: { error: "PromptOwl sign-in is restricted" } }] });
    await expect(deviceLogin(SERVER, io(f))).rejects.toThrow(/403: PromptOwl sign-in is restricted[\s\S]*--key-stdin/);
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

  it("leaves explicit registry auth alone and never reads the store for it", async () => {
    const connect = vi.fn(async () => conn);
    const lookup = vi.fn(async () => "cnst_saved");
    const spec = { ...http, auth: { bearer_env: "MY_KEY" } };
    await connectTarget({ alias: "h", spec }, lookup, connect as never);
    expect(lookup).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith("h", spec);
  });

  it("rewrites an auth failure to point at ctx login, and surfaces an unreadable store", async () => {
    const reject = vi.fn(async () => {
      throw new ContextNestError("rejected — Check that CONTEXTNEST_LOGIN_TOKEN is exported", "REMOTE_AUTH_FAILED");
    });
    await expect(connectTarget({ alias: "h", spec: http }, async () => "cnst_old", reject as never)).rejects.toThrow(
      /ctx login <server>` again/,
    );
    await expect(
      connectTarget(
        { alias: "h", spec: http },
        async () => {
          throw new Error("Saved `ctx login` keys exist but couldn't be read: wrong key");
        },
        reject as never,
      ),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/couldn't be read/) });
  });
});
