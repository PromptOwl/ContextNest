/**
 * Remote `scope` (server vs one nest) and `renameVault` — ticket wdqcq05aey.
 * Real registry file in a temp dir; nothing mocked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addVault, addRemote, listVaults, readRegistry, renameVault, setDefaultVault } from "../registry.js";
import { ConfigError } from "../errors.js";

describe("remote scope + renameVault", () => {
  let tmp: string;
  let saved: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-reg-scope-"));
    saved = process.env.CONTEXTNEST_CONFIG_DIR;
    process.env.CONTEXTNEST_CONFIG_DIR = join(tmp, "cfg");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CONTEXTNEST_CONFIG_DIR;
    else process.env.CONTEXTNEST_CONFIG_DIR = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  const vault = (name: string) => {
    const root = join(tmp, name);
    mkdirSync(join(root, ".context"), { recursive: true });
    writeFileSync(join(root, ".context", "config.yaml"), `version: 1\nname: ${name}\n`);
    return root;
  };

  it("stores scope and account, and lists them", () => {
    addRemote("srv", { transport: "http", url: "https://n.example.com/mcp", scope: "server", account: "work" });
    addRemote("one", { transport: "http", url: "https://n.example.com/nests/a/mcp", scope: "nest" });
    expect(readRegistry().remotes?.srv).toMatchObject({ scope: "server", account: "work" });
    const rows = listVaults();
    expect(rows.find((v) => v.alias === "srv")).toMatchObject({ scope: "server", account: "work" });
    expect(rows.find((v) => v.alias === "one")).toMatchObject({ scope: "nest" });
  });

  it("leaves scope off when it was never set, and refuses an unknown scope", () => {
    addRemote("plain", { transport: "http", url: "https://n.example.com/mcp" });
    expect(listVaults().find((v) => v.alias === "plain")).not.toHaveProperty("scope");
    expect(() =>
      addRemote("bad", { transport: "http", url: "https://n.example.com/mcp", scope: "galaxy" as never }),
    ).toThrow(ConfigError);
  });

  it("renames a remote, keeps its entry and scope, and moves the default pointer", () => {
    addRemote("srv", { transport: "http", url: "https://n.example.com/mcp", scope: "server" });
    setDefaultVault("srv");
    const { wasDefault } = renameVault("srv", "work");
    expect(wasDefault).toBe(true);
    const reg = readRegistry();
    expect(reg.remotes?.srv).toBeUndefined();
    expect(reg.remotes?.work).toMatchObject({ scope: "server", url: "https://n.example.com/mcp" });
    expect(reg.default).toBe("work");
  });

  it("renames a local vault, and keeps registry order", () => {
    addVault("a", vault("a"));
    addVault("b", vault("b"));
    renameVault("a", "first");
    expect(Object.keys(readRegistry().vaults)).toEqual(["first", "b"]);
  });

  it("refuses a missing source, an existing target (either map), the same name, and an unsafe alias", () => {
    addVault("a", vault("a"));
    addRemote("r", { transport: "http", url: "https://n.example.com/mcp" });
    expect(() => renameVault("nope", "x")).toThrow(/No vault registered/);
    expect(() => renameVault("a", "r")).toThrow(/already exists/);
    expect(() => renameVault("r", "a")).toThrow(/already exists/);
    expect(() => renameVault("a", "a")).toThrow(/already named/);
    expect(() => renameVault("a", "bad name")).toThrow(ConfigError);
    expect(() => renameVault("a", "__proto__")).toThrow(ConfigError);
  });
});
