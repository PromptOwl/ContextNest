/**
 * Plugin secrets live in the CLI's secure credential store (#169: OS keyring,
 * else the AES-256-GCM file store) — never in `.context/plugins.yaml`. An env
 * var CONTEXTNEST_PLUGIN_<NAME>_<KEY> stays the fallback and always wins.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringBackend } from "../keyring.js";
import { CredentialStoreError } from "../credentials.js";
import {
  PluginSecretStore,
  pluginSecretAccount,
  pluginEnvKey,
  splitSecretSettings,
  resolvePluginSettings,
} from "../plugin-secrets.js";

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

let home: string;
let vaultA: string;
let vaultB: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cn-plugsec-home-"));
  vaultA = mkdtempSync(join(tmpdir(), "cn-plugsec-a-"));
  vaultB = mkdtempSync(join(tmpdir(), "cn-plugsec-b-"));
});
afterEach(() => {
  for (const d of [home, vaultA, vaultB]) rmSync(d, { recursive: true, force: true });
});

describe("plugin secret account", () => {
  it("is scoped per vault and per plugin, and never contains the vault path in clear", () => {
    const a = pluginSecretAccount(vaultA, "memo");
    expect(a).toMatch(/^contextnest-plugin:[0-9a-f]{16}:memo$/);
    expect(a).not.toContain(vaultA);
    expect(pluginSecretAccount(vaultB, "memo")).not.toBe(a);
    expect(pluginSecretAccount(vaultA, "other")).not.toBe(a);
    expect(pluginSecretAccount(vaultA, "memo")).toBe(a);
  });

  it("env key is CONTEXTNEST_PLUGIN_<NAME>_<KEY>, dashes to underscores", () => {
    expect(pluginEnvKey("google-drive", "client_secret")).toBe("CONTEXTNEST_PLUGIN_GOOGLE_DRIVE_CLIENT_SECRET");
  });
});

describe("PluginSecretStore", () => {
  it("round-trips through the keyring and merges with what is already stored", async () => {
    const kr = memoryKeyring();
    const store = new PluginSecretStore({ home, env: {}, keyring: kr });
    expect(await store.load(vaultA, "memo")).toEqual({});
    await store.save(vaultA, "memo", { token: "sekrit" });
    await store.save(vaultA, "memo", { other: "two" });
    expect(await store.load(vaultA, "memo")).toEqual({ token: "sekrit", other: "two" });
    expect(await store.load(vaultB, "memo")).toEqual({});
    // nothing in clear on disk
    expect(existsSync(join(home, ".promptowl", "credentials.enc.json"))).toBe(false);
  });

  it("uses the encrypted file store when there is no keyring; the file never holds the secret in clear", async () => {
    const env = { CONTEXTNEST_CREDENTIALS_BACKEND: "file", CONTEXTNEST_CREDENTIALS_KEY: "pass phrase" };
    const store = new PluginSecretStore({ home, env, keyring: null });
    const where = await store.save(vaultA, "memo", { token: "sekrit" });
    expect(where).toMatch(/encrypted file/);
    expect(readFileSync(join(home, ".promptowl", "credentials.enc.json"), "utf-8")).not.toContain("sekrit");
    expect(await new PluginSecretStore({ home, env, keyring: null }).load(vaultA, "memo")).toEqual({ token: "sekrit" });
  });

  it("refuses to save with no secure store and points at the env fallback", async () => {
    const store = new PluginSecretStore({ home, env: {}, keyring: null });
    expect(await store.available()).toBe(false);
    await expect(store.save(vaultA, "memo", { token: "x" })).rejects.toBeInstanceOf(CredentialStoreError);
    await expect(store.save(vaultA, "memo", { token: "x" })).rejects.toThrow(/CONTEXTNEST_PLUGIN_MEMO_TOKEN/);
  });

  it("load with no secure store is empty, not an error (env-only setups keep working)", async () => {
    const store = new PluginSecretStore({ home, env: {}, keyring: null });
    expect(await store.load(vaultA, "memo")).toEqual({});
  });

  it("clear forgets every secret for that plugin in that vault only", async () => {
    const kr = memoryKeyring();
    const store = new PluginSecretStore({ home, env: {}, keyring: kr });
    await store.save(vaultA, "memo", { token: "a" });
    await store.save(vaultB, "memo", { token: "b" });
    await store.clear(vaultA, "memo");
    expect(await store.load(vaultA, "memo")).toEqual({});
    expect(await store.load(vaultB, "memo")).toEqual({ token: "b" });
  });
});

describe("splitSecretSettings / resolvePluginSettings", () => {
  const isSecret = (k: string) => k === "token";

  it("splits secret keys out of a settings map", () => {
    expect(splitSecretSettings({ prefix: "p", token: "t" }, isSecret)).toEqual({ plain: { prefix: "p" }, secret: { token: "t" } });
  });

  it("precedence: env > secure store > legacy plaintext in plugins.yaml", () => {
    const keys = ["prefix", "token"];
    expect(resolvePluginSettings("memo", keys, { prefix: "p", token: "legacy" }, {}, {})).toEqual({ prefix: "p", token: "legacy" });
    expect(resolvePluginSettings("memo", keys, { prefix: "p", token: "legacy" }, { token: "stored" }, {})).toEqual({ prefix: "p", token: "stored" });
    expect(
      resolvePluginSettings("memo", keys, { prefix: "p", token: "legacy" }, { token: "stored" }, { CONTEXTNEST_PLUGIN_MEMO_TOKEN: "env" }),
    ).toEqual({ prefix: "p", token: "env" });
    // an empty env var does not blank out a stored secret
    expect(resolvePluginSettings("memo", keys, {}, { token: "stored" }, { CONTEXTNEST_PLUGIN_MEMO_TOKEN: "" })).toEqual({ token: "stored" });
  });
});
