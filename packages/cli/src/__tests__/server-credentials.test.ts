import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringBackend } from "../keyring.js";
import {
  SERVERS_ACCOUNT,
  emptyServerMap,
  loadServerMap,
  normalizeServerUrl,
  parseServerMap,
  removeServer,
  saveServerMap,
  savedTokenFor,
  tokenForEndpoint,
  tokenForServer,
  upsertServer,
} from "../server-credentials.js";

const A = "https://nest.example.com";
const B = "http://localhost:3737";

function memoryKeyring(): KeyringBackend & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    name: "Mock Keyring",
    items,
    available: async () => true,
    get: async (a) => items.get(a) ?? null,
    set: async (a, s) => void items.set(a, s),
  };
}

describe("server map (pure)", () => {
  it("normalizes server URLs", () => {
    expect(normalizeServerUrl("HTTPS://Nest.Example.com/")).toBe(A);
    expect(normalizeServerUrl("https://nest.example.com/base/?x=1#y")).toBe(`${A}/base`);
    expect(() => normalizeServerUrl("ftp://x")).toThrow(/http/);
    expect(() => normalizeServerUrl("not a url")).toThrow(/Invalid/);
  });

  it("first server becomes default; removing it promotes the next", () => {
    let m = upsertServer(emptyServerMap(), A, { token: "ka" });
    m = upsertServer(m, B, { token: "kb" });
    expect(m.default).toBe(A);
    expect(tokenForServer(m)).toBe("ka");
    expect(tokenForServer(m, `${B}/`)).toBe("kb");
    m = removeServer(m, A);
    expect(m.default).toBe(B);
    expect(removeServer(m, B).default).toBeUndefined();
  });

  it("matches endpoints on a saved server by whole-segment longest prefix", () => {
    let m = upsertServer(emptyServerMap(), A, { token: "root" });
    m = upsertServer(m, `${A}/team`, { token: "team" });
    expect(tokenForEndpoint(m, `${A}/mcp`)).toBe("root");
    expect(tokenForEndpoint(m, `${A}/nests/abc/mcp`)).toBe("root");
    expect(tokenForEndpoint(m, `${A}/team/mcp`)).toBe("team");
    expect(tokenForEndpoint(m, `${A}/teammates/mcp`)).toBe("root");
    expect(tokenForEndpoint(m, "https://nest.example.com.evil.io/mcp")).toBeNull();
    expect(tokenForEndpoint(m, "http://nest.example.com/mcp")).toBeNull();
    expect(tokenForEndpoint(m, "garbage")).toBeNull();
  });

  it("parses defensively", () => {
    expect(parseServerMap("{nope")).toEqual(emptyServerMap());
    expect(parseServerMap(null)).toEqual(emptyServerMap());
    const m = parseServerMap(
      JSON.stringify({ version: 1, default: "x", servers: { [A]: { token: "k", label: 3 }, [B]: { nope: 1 } } }),
    );
    expect(m.servers).toEqual({ [A]: { token: "k" } });
    expect(m.default).toBeUndefined();
  });
});

describe("server map (secure store)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cn-servers-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("round-trips through the keyring and never writes a plaintext file", async () => {
    const keyring = memoryKeyring();
    const opts = { home, env: {}, keyring };
    await saveServerMap(upsertServer(emptyServerMap(), A, { token: "cnst_secret" }), opts);
    expect(keyring.items.has(SERVERS_ACCOUNT)).toBe(true);
    expect((await loadServerMap(opts)).servers[A].token).toBe("cnst_secret");
    expect(await savedTokenFor(`${A}/mcp`, opts)).toBe("cnst_secret");
    expect(existsSync(join(home, ".contextnest", "credentials.json"))).toBe(false);
  });

  it("encrypts at rest in the file store", async () => {
    const opts = { home, env: { CONTEXTNEST_CREDENTIALS_KEY: "k" }, keyring: null };
    await saveServerMap(upsertServer(emptyServerMap(), A, { token: "cnst_secret" }), opts);
    const raw = readFileSync(join(home, ".promptowl", "credentials.enc.json"), "utf-8");
    expect(raw).not.toContain("cnst_secret");
    expect(await savedTokenFor(A, opts)).toBe("cnst_secret");
  });

  it("refuses to save with no secure store, and lookups degrade to null", async () => {
    const opts = { home, env: {}, keyring: null };
    await expect(saveServerMap(upsertServer(emptyServerMap(), A, { token: "t" }), opts)).rejects.toThrow(
      /keyring/i,
    );
    expect(await savedTokenFor(A, opts)).toBeNull();
  });
});
