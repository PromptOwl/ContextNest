/**
 * Registry `remotes:` map — schema validation, registration, resolution.
 *
 * Covers the remote-nest additions to the vault registry (see
 * docs/plans/remote-nests-mcp-integration.md §3): the on-disk schema and its
 * guard rails (env-ref-only auth, one alias namespace), addRemote /
 * removeVault / setDefaultVault semantics, kind-aware listVaults, and the
 * resolveNest precedence including its interplay with resolveVaultPath's
 * local-only guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addVault,
  addRemote,
  removeVault,
  setDefaultVault,
  listVaults,
  setVaultDescription,
  readRegistry,
  getRegistryPath,
  resolveNest,
  resolveVaultPath,
  describeRemoteEndpoint,
} from "../registry.js";
import { ConfigError } from "../errors.js";
import type { RemoteNestSpec } from "../types.js";

/** Create a directory that looks like a vault (has .context/config.yaml). */
function makeVault(root: string, name = "Test Vault"): string {
  mkdirSync(join(root, ".context"), { recursive: true });
  writeFileSync(join(root, ".context", "config.yaml"), `version: 1\nname: "${name}"\n`);
  return root;
}

const HTTP_SPEC: RemoteNestSpec = {
  transport: "http",
  url: "https://nest.example.com/mcp",
  auth: { bearer_env: "CN_TOKEN" },
};

const STDIO_SPEC: RemoteNestSpec = {
  transport: "stdio",
  command: "/usr/bin/node",
  args: ["server.js", "/srv/vault"],
};

describe("registry remotes", () => {
  let tmp: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-reg-remote-"));
    savedEnv = {
      CONTEXTNEST_CONFIG_DIR: process.env.CONTEXTNEST_CONFIG_DIR,
      CONTEXTNEST_VAULT: process.env.CONTEXTNEST_VAULT,
      CONTEXTNEST_VAULT_PATH: process.env.CONTEXTNEST_VAULT_PATH,
    };
    process.env.CONTEXTNEST_CONFIG_DIR = join(tmp, "cfg");
    delete process.env.CONTEXTNEST_VAULT;
    delete process.env.CONTEXTNEST_VAULT_PATH;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Write a raw registry file, bypassing addVault/addRemote validation. */
  function writeRawRegistry(yaml: string): void {
    mkdirSync(join(tmp, "cfg"), { recursive: true });
    writeFileSync(getRegistryPath(), yaml, "utf-8");
  }

  // ── addRemote ─────────────────────────────────────────────────────────────

  it("registers an http remote and round-trips it through the registry file", () => {
    addRemote("team", HTTP_SPEC);
    const reg = readRegistry();
    expect(reg.remotes?.team).toEqual(HTTP_SPEC);
  });

  it("registers a stdio remote with its args array intact", () => {
    addRemote("research", STDIO_SPEC);
    expect(readRegistry().remotes?.research).toEqual(STDIO_SPEC);
  });

  it("rejects malformed aliases with the same rules as local vaults", () => {
    for (const bad of ["my vault", "a/b", "a:b", ""]) {
      expect(() => addRemote(bad, HTTP_SPEC)).toThrow(ConfigError);
    }
    expect(() => addRemote("ok-alias_1", HTTP_SPEC)).not.toThrow();
  });

  it("rejects an invalid spec (unknown transport, missing url/command)", () => {
    expect(() => addRemote("x", { transport: "ftp", url: "x" } as any)).toThrow(ConfigError);
    expect(() => addRemote("x", { transport: "http" } as any)).toThrow(ConfigError);
    expect(() => addRemote("x", { transport: "stdio" } as any)).toThrow(ConfigError);
  });

  it("rejects raw secrets in auth, naming the env-ref fields", () => {
    expect(() =>
      addRemote("x", {
        transport: "http",
        url: "https://x/mcp",
        auth: { bearer: "cnst_raw" } as any,
      }),
    ).toThrow(/bearer_env/);
  });

  it("rejects credentials over cleartext http to a non-loopback host", () => {
    expect(() =>
      addRemote("x", {
        transport: "http",
        url: "http://nest.example.com/mcp",
        auth: { bearer_env: "CN_TOKEN" },
      }),
    ).toThrow(/cleartext|https/);
  });

  it("allows credentials over https, and over loopback http for local testing", () => {
    expect(() => addRemote("secure", HTTP_SPEC)).not.toThrow();
    for (const [alias, host] of [
      ["lo1", "localhost"],
      ["lo2", "127.0.0.1"],
      ["lo3", "127.1.2.3"],
    ] as const) {
      expect(() =>
        addRemote(alias, {
          transport: "http",
          url: `http://${host}:8080/mcp`,
          auth: { bearer_env: "CN_TOKEN" },
        }),
      ).not.toThrow();
    }
  });

  it("allows cleartext http WITHOUT credentials (nothing secret to leak)", () => {
    expect(() =>
      addRemote("open", { transport: "http", url: "http://nest.example.com/mcp" }),
    ).not.toThrow();
  });

  it("rejects unparseable and non-http(s) urls", () => {
    expect(() => addRemote("x", { transport: "http", url: "not a url" })).toThrow(/valid URL/);
    expect(() => addRemote("x", { transport: "http", url: "ftp://x/mcp" })).toThrow(/http/);
  });

  it("readRegistry enforces the cleartext-credentials rule on hand-edited files too", () => {
    writeRawRegistry(
      [
        "version: 1",
        "vaults: {}",
        "remotes:",
        "  insecure:",
        "    transport: http",
        "    url: http://nest.example.com/mcp",
        "    auth:",
        "      bearer_env: CN_TOKEN",
        "",
      ].join("\n"),
    );
    expect(() => readRegistry()).toThrow(/cleartext|https/);
  });

  it("the first-ever registry entry becomes the default, later ones do not", () => {
    addRemote("first", HTTP_SPEC);
    expect(readRegistry().default).toBe("first");
    addRemote("second", STDIO_SPEC);
    expect(readRegistry().default).toBe("first");
  });

  it("does not steal the default when local vaults already exist", () => {
    addVault("localone", makeVault(join(tmp, "v")));
    addRemote("team", HTTP_SPEC);
    expect(readRegistry().default).toBe("localone");
  });

  it("setDefault opt-in promotes a remote explicitly", () => {
    addVault("localone", makeVault(join(tmp, "v")));
    addRemote("team", HTTP_SPEC, { setDefault: true });
    expect(readRegistry().default).toBe("team");
  });

  it("duplicate remote alias requires force; force keeps the alias but swaps the spec", () => {
    addRemote("dup", HTTP_SPEC);
    expect(() => addRemote("dup", STDIO_SPEC)).toThrow(/already exists/);
    addRemote("dup", STDIO_SPEC, { force: true });
    expect(readRegistry().remotes?.dup).toEqual(STDIO_SPEC);
  });

  it("blocks a remote alias colliding with a local vault, and vice versa — even with force", () => {
    addVault("shared", makeVault(join(tmp, "v")));
    expect(() => addRemote("shared", HTTP_SPEC)).toThrow(/already exists/);
    expect(() => addRemote("shared", HTTP_SPEC, { force: true })).toThrow(/already exists/);

    addRemote("team", HTTP_SPEC);
    const other = makeVault(join(tmp, "other"));
    expect(() => addVault("team", other)).toThrow(/already exists/);
    expect(() => addVault("team", other, { force: true })).toThrow(/already exists/);
  });

  // ── removeVault / setDefaultVault on remotes ──────────────────────────────

  it("removeVault removes a remote and clears the default it held", () => {
    addRemote("team", HTTP_SPEC, { setDefault: true });
    const { wasDefault } = removeVault("team");
    expect(wasDefault).toBe(true);
    const reg = readRegistry();
    expect(reg.remotes?.team).toBeUndefined();
    expect(reg.default).toBeUndefined();
  });

  it("removeVault drops the remotes map entirely when the last remote goes", () => {
    addRemote("team", HTTP_SPEC);
    removeVault("team");
    expect(readRegistry().remotes).toBeUndefined();
  });

  it("setDefaultVault accepts a remote alias and rejects unknown aliases", () => {
    addVault("localone", makeVault(join(tmp, "v")));
    addRemote("team", HTTP_SPEC);
    setDefaultVault("team");
    expect(readRegistry().default).toBe("team");
    expect(() => setDefaultVault("nope")).toThrow(/No vault registered/);
  });

  // ── schema guard rails on read ────────────────────────────────────────────

  it("readRegistry rejects a hand-edited raw secret with an env-ref message", () => {
    writeRawRegistry(
      [
        "version: 1",
        "vaults: {}",
        "remotes:",
        "  bad:",
        "    transport: http",
        "    url: https://x/mcp",
        "    auth:",
        "      bearer: cnst_raw_secret",
        "",
      ].join("\n"),
    );
    expect(() => readRegistry()).toThrow(/bearer_env|header_env/);
  });

  it("readRegistry rejects an alias registered as both vault and remote", () => {
    const v = makeVault(join(tmp, "v"));
    writeRawRegistry(
      [
        "version: 1",
        "vaults:",
        "  both:",
        `    path: ${JSON.stringify(v)}`,
        "remotes:",
        "  both:",
        "    transport: http",
        "    url: https://x/mcp",
        "",
      ].join("\n"),
    );
    expect(() => readRegistry()).toThrow(/one namespace|both a vault and a remote/);
  });

  it("readRegistry rejects a malformed remote alias key", () => {
    writeRawRegistry(
      [
        "version: 1",
        "vaults: {}",
        "remotes:",
        '  "bad alias":',
        "    transport: http",
        "    url: https://x/mcp",
        "",
      ].join("\n"),
    );
    expect(() => readRegistry()).toThrow(ConfigError);
  });

  it("readRegistry rejects a non-positive timeout_ms", () => {
    writeRawRegistry(
      [
        "version: 1",
        "vaults: {}",
        "remotes:",
        "  slow:",
        "    transport: http",
        "    url: https://x/mcp",
        "    timeout_ms: -5",
        "",
      ].join("\n"),
    );
    expect(() => readRegistry()).toThrow(ConfigError);
  });

  it("a registry with unknown top-level keys still parses (forward compat)", () => {
    // The inverse of the old-CLI guarantee: newer registries may grow more
    // top-level maps; this CLI must strip, not reject, what it doesn't know.
    writeRawRegistry(
      ["version: 1", "vaults: {}", "future_things:", "  x: 1", ""].join("\n"),
    );
    expect(readRegistry().vaults).toEqual({});
  });

  // ── listVaults ────────────────────────────────────────────────────────────

  it("listVaults reports kind, endpoint fields, and default across both maps", () => {
    addVault("localone", makeVault(join(tmp, "v")));
    addRemote("team", HTTP_SPEC);
    addRemote("research", { ...STDIO_SPEC, description: "Research nest" });

    const list = listVaults();
    const local = list.find((e) => e.alias === "localone")!;
    expect(local.kind).toBe("local");
    expect(local.exists).toBe(true);
    expect(local.isDefault).toBe(true);

    const team = list.find((e) => e.alias === "team")!;
    expect(team).toMatchObject({ kind: "remote", transport: "http", url: HTTP_SPEC.url });
    expect(team.exists).toBeUndefined();
    expect(team.path).toBeUndefined();

    const research = list.find((e) => e.alias === "research")!;
    expect(research).toMatchObject({
      kind: "remote",
      transport: "stdio",
      command: STDIO_SPEC.command,
      description: "Research nest",
    });
    expect(research.args).toEqual((STDIO_SPEC as any).args);
  });

  // ── resolveNest precedence ────────────────────────────────────────────────

  it("--vault flag resolves a remote alias", () => {
    addRemote("team", HTTP_SPEC);
    const nest = resolveNest({ vaultAlias: "team", cwd: tmp });
    expect(nest).toMatchObject({ kind: "remote", alias: "team", source: "flag" });
  });

  it("CONTEXTNEST_VAULT env alias resolves a remote", () => {
    addRemote("team", HTTP_SPEC);
    process.env.CONTEXTNEST_VAULT = "team";
    const nest = resolveNest({ cwd: tmp });
    expect(nest).toMatchObject({ kind: "remote", alias: "team", source: "env-alias" });
  });

  it("positional arg resolves a remote alias", () => {
    addRemote("team", HTTP_SPEC);
    const nest = resolveNest({ argPath: "team", cwd: tmp });
    expect(nest).toMatchObject({ kind: "remote", alias: "team", source: "arg" });
  });

  it("a remote default is used from a non-vault cwd", () => {
    addRemote("team", HTTP_SPEC, { setDefault: true });
    const nest = resolveNest({ cwd: tmp });
    expect(nest).toMatchObject({ kind: "remote", alias: "team", source: "default" });
  });

  it("a local vault found by cwd walk-up outranks a remote default", () => {
    addRemote("team", HTTP_SPEC, { setDefault: true });
    const inside = makeVault(join(tmp, "here"));
    const nest = resolveNest({ cwd: inside });
    expect(nest).toMatchObject({ kind: "local", path: inside, source: "local" });
  });

  it("an explicit --vault flag naming a LOCAL alias still resolves locally", () => {
    addRemote("team", HTTP_SPEC);
    const v = makeVault(join(tmp, "v"));
    addVault("localone", v);
    const nest = resolveNest({ vaultAlias: "localone", cwd: tmp });
    expect(nest).toMatchObject({ kind: "local", path: v, alias: "localone" });
  });

  it("falls back to cwd when nothing matches (kind local)", () => {
    const nest = resolveNest({ cwd: tmp });
    expect(nest).toMatchObject({ kind: "local", path: tmp, source: "cwd" });
  });

  // ── resolveVaultPath guard ────────────────────────────────────────────────

  it("resolveVaultPath throws a local-only error naming the remote alias and endpoint", () => {
    addRemote("team", HTTP_SPEC);
    expect(() => resolveVaultPath({ vaultAlias: "team", cwd: tmp })).toThrow(
      /remote nest.*nest\.example\.com|"team" is a remote/,
    );
    try {
      resolveVaultPath({ vaultAlias: "team", cwd: tmp });
    } catch (err) {
      expect((err as Error).message).toContain("team");
      expect((err as Error).message).toMatch(/remote/i);
      expect((err as Error).message).toMatch(/local-only/i);
    }
  });

  it("resolveVaultPath still resolves local aliases unchanged", () => {
    const v = makeVault(join(tmp, "v"));
    addVault("localone", v);
    expect(resolveVaultPath({ vaultAlias: "localone", cwd: tmp }).path).toBe(v);
  });

  // ── alias guards and default promotion, matched to addVault ───────────────

  it.each(["__proto__", "constructor", "prototype"])(
    "addRemote rejects the reserved alias %s, exactly as addVault does",
    (alias) => {
      expect(() => addRemote(alias, HTTP_SPEC)).toThrow(ConfigError);
      expect(readRegistry().remotes?.[alias]).toBeUndefined();
    },
  );

  it("addRemote promotes a new remote to default whenever no default is set", () => {
    // Matches addVault's rule: "first entry with no default wins". An earlier
    // stricter condition (vaults empty AND exactly one remote) made this
    // diverge once a second remote existed.
    // Land on a registry with one remote already present and NO default — the
    // state left behind when a promoted alias is later removed. (addRemote
    // first, so the registry directory exists.)
    addRemote("first", HTTP_SPEC);
    writeFileSync(
      getRegistryPath(),
      `version: 1\nremotes:\n  first:\n    transport: http\n    url: "${HTTP_SPEC.url}"\n`,
      "utf-8",
    );
    expect(readRegistry().default).toBeUndefined();

    addRemote("second", STDIO_SPEC);
    expect(readRegistry().default).toBe("second");
  });

  it("setVaultDescription edits a remote's description too", () => {
    addRemote("team", HTTP_SPEC);
    setVaultDescription("team", "Shared team nest");
    expect(readRegistry().remotes?.team?.description).toBe("Shared team nest");
    expect(listVaults().find((v) => v.alias === "team")?.description).toBe("Shared team nest");

    setVaultDescription("team");
    expect(readRegistry().remotes?.team?.description).toBeUndefined();
  });

  // ── describeRemoteEndpoint ────────────────────────────────────────────────

  it("describeRemoteEndpoint renders http urls and stdio command lines", () => {
    expect(describeRemoteEndpoint(HTTP_SPEC)).toBe("https://nest.example.com/mcp");
    expect(describeRemoteEndpoint(STDIO_SPEC)).toBe("/usr/bin/node server.js /srv/vault");
    expect(describeRemoteEndpoint({ transport: "stdio", command: "solo" })).toBe("solo");
  });
});
