import { describe, it, expect } from "vitest";
import {
  normalizeServerUrl,
  emptyStore,
  upsertCredential,
  removeCredential,
  resolveToken,
  parseStore,
  serializeStore,
  type CredentialStore,
} from "../credentials.js";

describe("normalizeServerUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeServerUrl("https://nest.acme.com/")).toBe(
      "https://nest.acme.com",
    );
  });
  it("lowercases scheme + host but preserves path/port casing", () => {
    expect(normalizeServerUrl("HTTPS://Nest.ACME.com:3737")).toBe(
      "https://nest.acme.com:3737",
    );
  });
  it("throws on a non-http(s) URL", () => {
    expect(() => normalizeServerUrl("ftp://x")).toThrow();
    expect(() => normalizeServerUrl("not a url")).toThrow();
  });
});

describe("upsert / remove", () => {
  it("adds a server credential keyed by normalized url", () => {
    const s = upsertCredential(emptyStore(), "https://a.com/", {
      token: "cnst_a",
    });
    expect(s.servers["https://a.com"].token).toBe("cnst_a");
  });
  it("replaces the credential for the same normalized url", () => {
    let s = upsertCredential(emptyStore(), "https://a.com", { token: "cnst_1" });
    s = upsertCredential(s, "https://a.com/", { token: "cnst_2" });
    expect(Object.keys(s.servers)).toEqual(["https://a.com"]);
    expect(s.servers["https://a.com"].token).toBe("cnst_2");
  });
  it("first server added becomes the default", () => {
    const s = upsertCredential(emptyStore(), "https://a.com", { token: "t" });
    expect(s.default).toBe("https://a.com");
  });
  it("removing the default promotes another server, or clears it when none left", () => {
    let s = upsertCredential(emptyStore(), "https://a.com", { token: "t1" });
    s = upsertCredential(s, "https://b.com", { token: "t2" });
    expect(s.default).toBe("https://a.com");
    s = removeCredential(s, "https://a.com");
    expect(s.default).toBe("https://b.com"); // promoted
    s = removeCredential(s, "https://b.com");
    expect(s.default).toBeUndefined();
    expect(s.servers).toEqual({});
  });
});

describe("resolveToken", () => {
  const store: CredentialStore = {
    version: 1,
    default: "https://a.com",
    servers: {
      "https://a.com": { token: "cnst_a" },
      "https://b.com": { token: "cnst_b" },
    },
  };
  it("resolves the token for an explicit url (normalized)", () => {
    expect(resolveToken(store, "https://b.com/")).toBe("cnst_b");
  });
  it("falls back to the default server when no url is given", () => {
    expect(resolveToken(store)).toBe("cnst_a");
  });
  it("returns null for an unknown server", () => {
    expect(resolveToken(store, "https://ghost.com")).toBeNull();
  });
  it("returns null when no url and no default", () => {
    expect(resolveToken({ version: 1, servers: {} })).toBeNull();
  });
});

describe("parse / serialize", () => {
  it("round-trips a store", () => {
    const s = upsertCredential(emptyStore(), "https://a.com", {
      token: "cnst_a",
      label: "me@x.com",
    });
    expect(parseStore(serializeStore(s))).toEqual(s);
  });
  it("defensively returns an empty store for junk / null", () => {
    expect(parseStore(null)).toEqual(emptyStore());
    expect(parseStore("{not json")).toEqual(emptyStore());
    expect(parseStore(JSON.stringify({ servers: "nope" }))).toEqual(emptyStore());
  });
  it("drops malformed server entries (missing token)", () => {
    const json = JSON.stringify({
      version: 1,
      servers: { "https://a.com": { nope: 1 }, "https://b.com": { token: "ok" } },
    });
    const parsed = parseStore(json);
    expect(Object.keys(parsed.servers)).toEqual(["https://b.com"]);
  });
});
