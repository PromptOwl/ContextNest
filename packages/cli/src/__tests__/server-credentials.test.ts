import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringBackend } from "../keyring.js";
import {
  SERVERS_ACCOUNT,
  accountKey,
  assertServerMapWritable,
  splitAccountKey,
  tokensForServerEndpoint,
  emptyServerMap,
  isNestScope,
  keysUnderServer,
  loadServerMap,
  loggedInServers,
  nestScopeUrl,
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
    // Nor the other way: a key saved for plaintext http never reaches the https origin, or vice versa.
    const plain = upsertServer(emptyServerMap(), "http://h.example", { token: "plain" });
    expect(tokenForEndpoint(plain, "https://h.example/mcp")).toBeNull();
  });

  it("parses defensively, but refuses corrupt or newer-format data instead of emptying it", () => {
    expect(parseServerMap(null)).toEqual(emptyServerMap());
    expect(() => parseServerMap("{nope")).toThrow(/unreadable/);
    expect(() => parseServerMap("[]")).toThrow(/unreadable/);
    expect(() => parseServerMap(JSON.stringify({ version: 2, servers: {} }))).toThrow(/newer ctx/);
    const m = parseServerMap(
      JSON.stringify({ version: 1, default: "x", servers: { [A]: { token: "k", label: 3 }, [B]: { nope: 1 } } }),
    );
    expect(m.servers).toEqual({ [A]: { token: "k" } });
    expect(m.default).toBeUndefined();
  });

  // Qaish's case: the public hosted server, a self-hosted one, and a
  // nest-scoped key on the hosted server, all at once.
  const HOSTED = "https://nest.promptowl.ai";
  const SELF = "https://nest.corp.internal/contextnest";

  it("holds hosted, self-hosted and nest-scoped keys side by side", () => {
    let m = upsertServer(emptyServerMap(), HOSTED, { token: "hosted" });
    m = upsertServer(m, SELF, { token: "self" });
    m = upsertServer(m, nestScopeUrl(HOSTED, "n1"), { token: "n1-only" });
    expect(tokenForEndpoint(m, `${HOSTED}/nests/n1/mcp`)).toBe("n1-only");
    expect(tokenForEndpoint(m, `${HOSTED}/nests/n10/mcp`)).toBe("hosted");
    expect(tokenForEndpoint(m, `${HOSTED}/nests/n2/mcp`)).toBe("hosted");
    expect(tokenForEndpoint(m, `${SELF}/nests/n1/mcp`)).toBe("self");
    expect(tokenForEndpoint(m, "https://nest.corp.internal/mcp")).toBeNull();
    expect(keysUnderServer(m, HOSTED).sort()).toEqual([HOSTED, `${HOSTED}/nests/n1`]);
    expect(keysUnderServer(m, SELF)).toEqual([SELF]);
  });

  it("never makes a nest-scoped key the default server", () => {
    let m = upsertServer(emptyServerMap(), nestScopeUrl(HOSTED, "n1"), { token: "n1" });
    expect(m.default).toBeUndefined();
    m = upsertServer(m, SELF, { token: "self" });
    expect(m.default).toBe(SELF);
    m = upsertServer(m, HOSTED, { token: "hosted" });
    expect(removeServer(m, SELF).default).toBe(HOSTED);
    expect(isNestScope(`${HOSTED}/nests/n1`)).toBe(true);
    expect(isNestScope(HOSTED)).toBe(false);
  });

  it("lists every key that opens a server endpoint, server-wide first", () => {
    let m = upsertServer(emptyServerMap(), nestScopeUrl(HOSTED, "n1"), { token: "n1-only" });
    expect(tokensForServerEndpoint(m, `${HOSTED}/mcp`)).toEqual(["n1-only"]);
    m = upsertServer(m, HOSTED, { token: "hosted" });
    m = upsertServer(m, SELF, { token: "self" });
    expect(tokensForServerEndpoint(m, `${HOSTED}/mcp`)).toEqual(["hosted", "n1-only"]);
    expect(tokensForServerEndpoint(m, `${SELF}/mcp`)).toEqual(["self"]);
    expect(tokensForServerEndpoint(m, "https://other.example/mcp")).toEqual([]);
    expect(tokensForServerEndpoint(m, "garbage")).toEqual([]);
    // Only a server-level endpoint fans out; one nest's endpoint keeps the longest match.
    expect(tokensForServerEndpoint(m, `${HOSTED}/nests/n1/mcp`)).toEqual([]);
    expect(tokensForServerEndpoint(m, HOSTED)).toEqual([]);
  });

  it("keeps a named account's keys apart from the unnamed one on the same server", () => {
    let m = upsertServer(emptyServerMap(), HOSTED, { token: "me" });
    m = upsertServer(m, HOSTED, { token: "client" }, "client");
    m = upsertServer(m, nestScopeUrl(HOSTED, "n1"), { token: "client-n1" }, "client");
    expect(Object.keys(m.servers).sort()).toEqual([HOSTED, `${HOSTED}#client`, `${HOSTED}/nests/n1#client`]);
    expect(m.default).toBe(HOSTED);
    expect(tokenForEndpoint(m, `${HOSTED}/mcp`)).toBe("me");
    expect(tokenForEndpoint(m, `${HOSTED}/mcp`, "client")).toBe("client");
    expect(tokenForEndpoint(m, `${HOSTED}/nests/n1`, "client")).toBe("client-n1");
    expect(tokenForEndpoint(m, `${HOSTED}/nests/n1`)).toBe("me");
    expect(tokenForEndpoint(m, `${HOSTED}/mcp`, "nobody")).toBeNull();
    expect(keysUnderServer(m, HOSTED)).toEqual([HOSTED]);
    expect(keysUnderServer(m, HOSTED, "client").sort()).toEqual([`${HOSTED}#client`, `${HOSTED}/nests/n1#client`]);
    expect(tokensForServerEndpoint(m, `${HOSTED}/mcp`, "client")).toEqual(["client", "client-n1"]);
    expect(isNestScope(`${HOSTED}/nests/n1#client`)).toBe(true);
    // A named account never becomes the default, nor is promoted to it.
    expect(upsertServer(emptyServerMap(), HOSTED, { token: "x" }, "client").default).toBeUndefined();
    m = removeServer(m, HOSTED);
    expect(m.default).toBeUndefined();
    expect(Object.keys(removeServer(m, `${HOSTED}#client`).servers)).toEqual([`${HOSTED}/nests/n1#client`]);
    expect(splitAccountKey(`${HOSTED}#client`)).toEqual({ scope: HOSTED, account: "client" });
    for (const bad of ["", "a b", "a/b", "a#b"]) expect(() => accountKey(HOSTED, bad)).toThrow(/account/);
  });

  it("validates nest ids", () => {
    expect(nestScopeUrl(`${HOSTED}/`, " abc ")).toBe(`${HOSTED}/nests/abc`);
    for (const bad of ["", "a/b", "a?b", "a b", "a\\b"]) expect(() => nestScopeUrl(HOSTED, bad)).toThrow(/nest id/);
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

  it("refuses to save with no secure store; with nothing stored a lookup is just null", async () => {
    const opts = { home, env: {}, keyring: null };
    await expect(saveServerMap(upsertServer(emptyServerMap(), A, { token: "t" }), opts)).rejects.toThrow(
      /keyring/i,
    );
    expect(await savedTokenFor(A, opts)).toBeNull();
  });

  it("says saved keys are unreadable instead of pretending you're logged out", async () => {
    const env = { CONTEXTNEST_CREDENTIALS_KEY: "right" };
    await saveServerMap(upsertServer(emptyServerMap(), A, { token: "t" }), { home, env, keyring: null });
    for (const bad of [{}, { CONTEXTNEST_CREDENTIALS_KEY: "wrong" }]) {
      await expect(savedTokenFor(A, { home, env: bad, keyring: null })).rejects.toThrow(/couldn't be read/);
    }
  });

  it("the pre-login check fails on no secure store or an unreadable map, and passes on an empty store", async () => {
    await expect(assertServerMapWritable({ home, env: {}, keyring: null })).rejects.toThrow(/nowhere safe/);
    const corrupt = memoryKeyring();
    corrupt.items.set(SERVERS_ACCOUNT, "{corrupt");
    await expect(assertServerMapWritable({ home, env: {}, keyring: corrupt })).rejects.toThrow(/unreadable/);
    await expect(assertServerMapWritable({ home, env: {}, keyring: memoryKeyring() })).resolves.toBeUndefined();
  });

  it("skips the store read once a non-secret marker says nothing is saved", async () => {
    const keyring = memoryKeyring();
    let reads = 0;
    const counted = { ...keyring, get: async (a: string) => (reads++, keyring.get(a)) };
    const opts = { home, env: {}, keyring: counted };
    const marker = join(home, ".contextnest", "login-state");
    // No marker yet (fresh install, or keys saved by an older ctx): read once, then remember.
    expect(await savedTokenFor(A, opts)).toBeNull();
    expect(readFileSync(marker, "utf-8")).toBe("none");
    expect(reads).toBe(1);
    expect(await savedTokenFor(A, opts)).toBeNull();
    expect(reads).toBe(1);
    // A login flips it; the marker never holds the key.
    await saveServerMap(upsertServer(emptyServerMap(), A, { token: "cnst_secret" }), opts);
    expect(readFileSync(marker, "utf-8")).toBe("saved");
    expect(await savedTokenFor(A, opts)).toBe("cnst_secret");
    // Logging out of everything flips it back.
    await saveServerMap(emptyServerMap(), opts);
    expect(readFileSync(marker, "utf-8")).toBe("none");
  });

  it("a fresh lookup reads the store even when the marker says nothing is saved", async () => {
    const keyring = memoryKeyring();
    const opts = { home, env: {}, keyring };
    expect(await savedTokenFor(A, opts)).toBeNull();
    // Keys written behind the marker's back (an older ctx, a hand edit).
    keyring.items.set(SERVERS_ACCOUNT, JSON.stringify(upsertServer(emptyServerMap(), A, { token: "old" })));
    expect(await savedTokenFor(A, opts)).toBeNull();
    expect(await savedTokenFor(A, { ...opts, fresh: true })).toBe("old");
    expect(readFileSync(join(home, ".contextnest", "login-state"), "utf-8")).toBe("saved");
  });

  it("a corrupt stored map fails loudly and is never overwritten by a lookup", async () => {
    const keyring = memoryKeyring();
    keyring.items.set(SERVERS_ACCOUNT, "{corrupt");
    const opts = { home, env: {}, keyring };
    await expect(loadServerMap(opts)).rejects.toThrow(/unreadable.*logout --all/);
    await expect(savedTokenFor(A, opts)).rejects.toThrow(/^Saved `ctx login` keys are unreadable/);
    expect(keyring.items.get(SERVERS_ACCOUNT)).toBe("{corrupt");
  });
});

describe("logged-in servers (plain file, no keys)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cn-logins-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const countingKeyring = () => {
    const ring = memoryKeyring();
    const stats = { reads: 0 };
    return { ring: { ...ring, get: async (a: string) => (stats.reads++, ring.get(a)) }, items: ring.items, stats };
  };
  const loginsFile = () => join(home, ".contextnest", "logins.json");

  it("lists server-wide logins (with accounts), never nest keys, and never writes a key", async () => {
    const { ring } = countingKeyring();
    const opts = { home, env: {}, keyring: ring };
    let map = upsertServer(emptyServerMap(), A, { token: "cnst_secret_one" });
    map = upsertServer(map, A, { token: "cnst_secret_two" }, "work");
    map = upsertServer(map, nestScopeUrl(B, "n1"), { token: "cnst_secret_three" });
    await saveServerMap(map, opts);
    expect(await loggedInServers(opts)).toEqual([{ url: A }, { url: A, account: "work" }]);
    expect(readFileSync(loginsFile(), "utf-8")).not.toContain("cnst_");
    if (process.platform !== "win32") expect(statSync(loginsFile()).mode & 0o077).toBe(0); // owner-only
  });

  it("follows a second login even when the marker stays 'saved'", async () => {
    const opts = { home, env: {}, keyring: memoryKeyring() };
    await saveServerMap(upsertServer(emptyServerMap(), A, { token: "t" }), opts);
    await saveServerMap(upsertServer(upsertServer(emptyServerMap(), A, { token: "t" }), B, { token: "t" }), opts);
    expect((await loggedInServers(opts)).map((s) => s.url)).toEqual([A, B]);
    await saveServerMap(emptyServerMap(), opts);
    expect(await loggedInServers(opts)).toEqual([]);
  });

  it("an upgraded user (key saved, no logins file) costs one store read, then none", async () => {
    const { ring, items, stats } = countingKeyring();
    items.set(SERVERS_ACCOUNT, JSON.stringify(upsertServer(emptyServerMap(), A, { token: "old" })));
    const opts = { home, env: {}, keyring: ring };
    expect(await loggedInServers(opts)).toEqual([{ url: A }]);
    expect(stats.reads).toBe(1);
    for (let i = 0; i < 5; i++) expect(await loggedInServers(opts)).toEqual([{ url: A }]);
    expect(stats.reads).toBe(1);
  });

  it("nothing saved: the marker answers and the store is never opened", async () => {
    const { ring, stats } = countingKeyring();
    const opts = { home, env: {}, keyring: ring };
    await saveServerMap(emptyServerMap(), opts);
    stats.reads = 0;
    expect(await loggedInServers(opts)).toEqual([]);
    expect(stats.reads).toBe(0);
  });

  it("an unreadable store is tried once, remembered, and does not throw", async () => {
    const { ring, items, stats } = countingKeyring();
    items.set(SERVERS_ACCOUNT, "{corrupt");
    const opts = { home, env: {}, keyring: ring };
    expect(await loggedInServers(opts)).toEqual([]);
    const after = stats.reads;
    expect(after).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) expect(await loggedInServers(opts)).toEqual([]);
    expect(stats.reads).toBe(after); // every later command skips the store
    // A good save repairs it.
    items.delete(SERVERS_ACCOUNT);
    await saveServerMap(upsertServer(emptyServerMap(), A, { token: "t" }), opts);
    expect(await loggedInServers(opts)).toEqual([{ url: A }]);
  });

  it("a corrupt logins file falls back to the store once", async () => {
    const { ring, items } = countingKeyring();
    items.set(SERVERS_ACCOUNT, JSON.stringify(upsertServer(emptyServerMap(), A, { token: "t" })));
    const opts = { home, env: {}, keyring: ring };
    await loggedInServers(opts);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(loginsFile(), "{not json");
    expect(await loggedInServers(opts)).toEqual([{ url: A }]);
    expect(JSON.parse(readFileSync(loginsFile(), "utf-8")).servers).toEqual([{ url: A }]);
  });
});
