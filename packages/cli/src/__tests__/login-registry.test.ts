/**
 * login-registry.test.ts — the pure rules behind registration, the hint, and
 * the exact re-login command. No IO, no mocks.
 */
import { describe, it, expect } from "vitest";
import type { RemoteNestSpec } from "@promptowl/contextnest-engine";
import {
  aliasesFor,
  deriveServerAlias,
  loginCommandFor,
  loginHintLine,
  loginTargetOfAlias,
  mayShowLoginHint,
  nestIdOf,
  scopeForEndpoint,
  serverOrigin,
  unregisteredLogins,
} from "../login-registry.js";

const none = () => false;

describe("deriveServerAlias", () => {
  it("takes the brand label of a hostname", () => {
    expect(deriveServerAlias("https://nest.promptowl.ai", none)).toBe("promptowl");
    expect(deriveServerAlias("https://www.example.com", none)).toBe("example");
    expect(deriveServerAlias("https://api.acme.io", none)).toBe("acme");
    expect(deriveServerAlias("https://community-nest-dev-619135602958.us-central1.run.app", none)).toBe(
      "community-nest-dev-619135602958",
    );
  });
  it("uses host and port for localhost, IPv4 and IPv6", () => {
    expect(deriveServerAlias("http://localhost:3737", none)).toBe("localhost-3737");
    expect(deriveServerAlias("http://127.0.0.1:8080", none)).toBe("127-0-0-1-8080");
    expect(deriveServerAlias("http://[::1]:9000", none)).toBe("1-9000");
    expect(deriveServerAlias("http://localhost", none)).toBe("localhost");
  });
  it("numbers collisions: -2, -3, …", () => {
    const taken = new Set(["promptowl", "promptowl-2"]);
    expect(deriveServerAlias("https://nest.promptowl.ai", (a) => taken.has(a))).toBe("promptowl-3");
  });
  it("always returns a name the registry accepts", () => {
    for (const url of ["https://Ünï.example.com", "https://a_b.example.com", "http://[2001:db8::1]:1"]) {
      expect(deriveServerAlias(url, none)).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe("endpoint shape", () => {
  it("tells a server from a nest from neither", () => {
    expect(scopeForEndpoint("https://h/mcp")).toBe("server");
    expect(scopeForEndpoint("https://h/mcp/")).toBe("server");
    expect(scopeForEndpoint("https://h/nests/abc/mcp")).toBe("nest");
    expect(scopeForEndpoint("https://h/custom/path")).toBeUndefined();
    expect(scopeForEndpoint("not a url")).toBeUndefined();
  });
  it("finds the origin and nest id", () => {
    expect(serverOrigin("https://h:8443/nests/abc/mcp")).toBe("https://h:8443");
    expect(serverOrigin("https://h/mcp?x=1#y")).toBe("https://h");
    expect(nestIdOf("https://h/nests/a%20b/mcp")).toBe("a b");
    expect(nestIdOf("https://h/mcp")).toBeUndefined();
  });
});

describe("loginCommandFor", () => {
  it("names the real server, never a placeholder", () => {
    expect(loginCommandFor({ url: "https://nest.promptowl.ai/mcp" })).toBe("ctx login https://nest.promptowl.ai");
  });
  it("carries the account", () => {
    expect(loginCommandFor({ url: "https://h/mcp", account: "work" })).toBe("ctx login https://h --account work");
  });
  it("asks for a pasted key when the endpoint, or the call, is one nest", () => {
    expect(loginCommandFor({ url: "https://h/nests/n1/mcp" })).toBe("ctx login https://h --nest n1 --key-stdin");
    expect(loginCommandFor({ url: "https://h/mcp", account: "w" }, "n2")).toBe(
      "ctx login https://h --nest n2 --account w --key-stdin",
    );
  });
});

describe("registered vs logged in", () => {
  const remotes: Record<string, RemoteNestSpec> = {
    srv: { transport: "http", url: "https://a.example.com/mcp", scope: "server" },
    one: { transport: "http", url: "https://b.example.com/nests/x/mcp", scope: "nest" },
    worker: { transport: "http", url: "https://c.example.com/mcp", account: "work" },
    keyed: { transport: "http", url: "https://d.example.com/mcp", auth: { bearer_env: "K" } },
    local: { transport: "stdio", command: "node" },
  };
  const logins = [
    { url: "https://a.example.com" },
    { url: "https://b.example.com" },
    { url: "https://c.example.com" },
    { url: "https://c.example.com", account: "work" },
    { url: "https://d.example.com" },
    { url: "https://e.example.com" },
  ];

  it("lists only logins no remote covers (a nest remote counts; env-key and other-account ones don't)", () => {
    expect(unregisteredLogins(logins, remotes).map((l) => `${l.url}${l.account ? "#" + l.account : ""}`)).toEqual([
      "https://c.example.com",
      "https://d.example.com",
      "https://e.example.com",
    ]);
  });
  it("everything is unregistered with no remotes at all", () => {
    expect(unregisteredLogins(logins, undefined)).toHaveLength(logins.length);
  });
  it("finds the aliases a key serves", () => {
    expect(aliasesFor(remotes, { url: "https://c.example.com", account: "work" })).toEqual(["worker"]);
    expect(aliasesFor(remotes, { url: "https://a.example.com" })).toEqual(["srv"]);
    expect(aliasesFor(remotes, { url: "https://zzz.example.com" })).toEqual([]);
  });
});

describe("loginTargetOfAlias", () => {
  const remotes: Record<string, RemoteNestSpec> = {
    po: { transport: "http", url: "https://nest.promptowl.ai/mcp", account: "w" },
    n: { transport: "http", url: "https://h/nests/n1/mcp" },
    s: { transport: "stdio", command: "x" },
  };
  it("resolves an alias to its server, account and nest", () => {
    expect(loginTargetOfAlias("po", remotes)).toEqual({ server: "https://nest.promptowl.ai", account: "w" });
    expect(loginTargetOfAlias("n", remotes)).toEqual({ server: "https://h", nest: "n1" });
  });
  it("leaves URLs, unknown names and stdio remotes alone", () => {
    expect(loginTargetOfAlias("https://po.example.com", remotes)).toBeNull();
    expect(loginTargetOfAlias("http://localhost:3737", { "http://localhost:3737": remotes.po })).toBeNull();
    expect(loginTargetOfAlias("nope", remotes)).toBeNull();
    expect(loginTargetOfAlias("s", remotes)).toBeNull();
  });
});

describe("mayShowLoginHint", () => {
  const base = { stderrIsTTY: true, json: false, command: "vault list", env: {}, disabled: false };
  it("shows for a person at a terminal", () => expect(mayShowLoginHint(base)).toBe(true));
  it.each([
    ["stderr is a pipe (agent, CI)", { stderrIsTTY: false }],
    ["--json", { json: true }],
    ["hints off", { disabled: true }],
    ["CONTEXTNEST_NO_HINTS=1", { env: { CONTEXTNEST_NO_HINTS: "1" } }],
    ["CI set", { env: { CI: "true" } }],
    ["login", { command: "login" }],
    ["logout", { command: "logout" }],
    ["vault add", { command: "vault add" }],
    ["hints", { command: "hints" }],
  ])("stays quiet: %s", (_why, over) => expect(mayShowLoginHint({ ...base, ...over })).toBe(false));
  it("CONTEXTNEST_NO_HINTS=0 does not silence", () =>
    expect(mayShowLoginHint({ ...base, env: { CONTEXTNEST_NO_HINTS: "0" } })).toBe(true));
});

describe("loginHintLine", () => {
  it("names the server, the fixing command and the switch", () => {
    const line = loginHintLine({ url: "https://nest.promptowl.ai" }, "promptowl");
    expect(line).toContain("logged in to https://nest.promptowl.ai");
    expect(line).toContain("ctx vault add promptowl --url https://nest.promptowl.ai/mcp");
    expect(line).toContain("ctx hints off");
    expect(line).not.toContain("\n");
  });
  it("carries the account", () =>
    expect(loginHintLine({ url: "https://h", account: "w" }, "h")).toContain("/mcp --account w"));
});
