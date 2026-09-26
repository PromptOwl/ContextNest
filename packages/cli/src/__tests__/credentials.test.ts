import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PROMPTOWL_ACCOUNT, loadCloudToken } from "../credentials.js";
import {
  type CommandRunner,
  type KeyringBackend,
  linuxSecretService,
  macKeychain,
  windowsCredentialManager,
} from "../keyring.js";

const TOKEN = "po_live_SECRET_TOKEN_1234567890";
const KEY = "correct horse battery staple";

function memoryKeyring(available = true): KeyringBackend & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    name: "Mock Keyring",
    items,
    available: async () => available,
    get: async (a) => items.get(a) ?? null,
    set: async (a, s) => void items.set(a, s),
  };
}

let home: string;
const legacy = () => join(home, ".promptowl", "credentials.json");
const enc = () => join(home, ".promptowl", "credentials.enc.json");
const writeLegacy = () => {
  mkdirSync(join(home, ".promptowl"), { recursive: true });
  writeFileSync(legacy(), JSON.stringify({ access_token: TOKEN }));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cn-creds-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("credential store", () => {
  it("migrates plaintext into the keyring on read and deletes the plaintext", async () => {
    writeLegacy();
    const kr = memoryKeyring();
    expect(await loadCloudToken({ home, env: {}, keyring: kr })).toBe(TOKEN);
    expect(existsSync(legacy())).toBe(false);
    expect(JSON.parse(kr.items.get(PROMPTOWL_ACCOUNT)!)).toEqual({ access_token: TOKEN });
    expect(await loadCloudToken({ home, env: {}, keyring: kr })).toBe(TOKEN);
  });

  it("does not delete the plaintext when the keyring write does not round-trip", async () => {
    writeLegacy();
    const kr = memoryKeyring();
    kr.set = async () => {};
    await expect(loadCloudToken({ home, env: {}, keyring: kr })).rejects.toThrow(/did not return/);
    expect(existsSync(legacy())).toBe(true);
  });

  it("falls back to an AES-256-GCM file (0600, no plaintext inside) when there is no keyring", async () => {
    writeLegacy();
    const env = { CONTEXTNEST_CREDENTIALS_KEY: KEY };
    expect(await loadCloudToken({ home, env, keyring: memoryKeyring(false) })).toBe(TOKEN);
    expect(existsSync(legacy())).toBe(false);
    const raw = readFileSync(enc(), "utf-8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain("access_token");
    if (process.platform !== "win32") expect(statSync(enc()).mode & 0o777).toBe(0o600);
    expect(await loadCloudToken({ home, env, keyring: null })).toBe(TOKEN);
  });

  it("errors on a wrong or missing key", async () => {
    await new CredentialStore({ home, env: { CONTEXTNEST_CREDENTIALS_KEY: KEY }, keyring: null }).set(
      PROMPTOWL_ACCOUNT,
      JSON.stringify({ access_token: TOKEN }),
    );
    await expect(loadCloudToken({ home, env: { CONTEXTNEST_CREDENTIALS_KEY: "nope" }, keyring: null })).rejects.toThrow(
      /does not match/,
    );
    await expect(loadCloudToken({ home, env: {}, keyring: null })).rejects.toThrow(/not set/);
  });

  it("never falls back to plaintext: no keyring and no key is an error, file left in place", async () => {
    writeLegacy();
    await expect(loadCloudToken({ home, env: {}, keyring: memoryKeyring(false) })).rejects.toThrow(
      /CONTEXTNEST_CREDENTIALS_KEY/,
    );
    expect(existsSync(legacy())).toBe(true);
    expect(existsSync(enc())).toBe(false);
  });

  it("nothing stored is anonymous; PROMPTOWL_ACCESS_TOKEN bypasses storage", async () => {
    expect(await loadCloudToken({ home, env: {}, keyring: null })).toBeNull();
    writeLegacy();
    expect(await loadCloudToken({ home, env: { PROMPTOWL_ACCESS_TOKEN: "envtok" }, keyring: null })).toBe("envtok");
    expect(existsSync(legacy())).toBe(true);
  });
});

describe("OS keyrings keep the secret off argv (runner mocked)", () => {
  type Call = { cmd: string; args: string[]; input?: string };
  const record = (respond: (c: Call) => { code: number; stdout?: string; stderr?: string }) => {
    const calls: Call[] = [];
    const runner: CommandRunner = async (cmd, args, input) => {
      const c = { cmd, args, input };
      calls.push(c);
      const r = respond(c);
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { calls, runner };
  };

  it("macOS: `security -i` over stdin; reads decode", async () => {
    let stored = "";
    const { calls, runner } = record((c) => {
      if (c.args[0] === "-i") stored = /-w (\S+)/.exec(c.input!)![1];
      return { code: 0, stdout: c.args[0] === "find-generic-password" ? stored + "\n" : "" };
    });
    const kc = macKeychain(runner);
    await kc.set("acct", TOKEN);
    expect(await kc.get("acct")).toBe(TOKEN);
    for (const c of calls) expect(c.args.join(" ") + (c.input ?? "")).not.toContain(TOKEN);
  });

  it("Linux: needs a session bus; secret-tool store reads the secret from stdin", async () => {
    const { calls, runner } = record((c) => ({ code: c.args[0] === "lookup" ? 1 : 0 }));
    expect(await linuxSecretService(runner, {}).available()).toBe(false);
    const ss = linuxSecretService(runner, { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" });
    expect(await ss.available()).toBe(true);
    await ss.set("acct", TOKEN);
    const store = calls.find((c) => c.args[0] === "store")!;
    expect(store.args.join(" ")).not.toContain(TOKEN);
    expect(Buffer.from(store.input!.replace("cnb64:", ""), "base64").toString()).toBe(TOKEN);
  });

  it("Windows: PowerShell script carries no secret; it goes over stdin", async () => {
    const { calls, runner } = record(() => ({ code: 0 }));
    await windowsCredentialManager(runner).set("acct", TOKEN);
    const script = Buffer.from(calls[0].args[calls[0].args.length - 1], "base64").toString("utf16le");
    expect(script).toContain("CredWriteW");
    expect(script).not.toContain(TOKEN);
    expect(calls[0].input).toBe(TOKEN);
  });

  it("a missing binary reads as unavailable", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(await macKeychain(runner).available()).toBe(false);
    expect(await windowsCredentialManager(runner).available()).toBe(false);
    expect(await linuxSecretService(runner, { DBUS_SESSION_BUS_ADDRESS: "x" }).available()).toBe(false);
  });
});
