/**
 * login-register.regression.test.ts — `ctx login` registers the server, end to
 * end through the compiled CLI (dist/index.js) against a REAL HTTP server
 * (helpers/nest-server.ts: Streamable-HTTP MCP, bearer auth, device login).
 * Nothing in the CLI is stubbed; the server is a genuine one on loopback.
 *
 * Covers the journeys in ticket wdqcq05aey: a new user, an existing user who
 * logged in before registration existed (the hint), re-authentication, a server
 * that is down, addressing nests behind a server alias, and old configs.
 *
 * The hint is for people at a terminal, so those cases run the CLI under a real
 * pseudo-terminal (Python's `pty`); they are skipped where that isn't available (Windows).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startNestServer, type NestServer } from "./helpers/nest-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const NESTS = [
  { id: "n-alpha-0001", name: "Alpha", description: "First nest" },
  { id: "n-beta-0002", name: "Beta", description: "Second nest" },
];
const KEY = "cnst_test_key_0001";
const KEY2 = "cnst_test_key_0002";
const HAS_PTY =
  process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

describe("ctx login registers the server (regression)", () => {
  let home: string;
  let server: NestServer;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    server = await startNestServer({ nests: NESTS, validKeys: [KEY, KEY2] });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cn-loginreg-"));
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CI: "",
      CONTEXTNEST_NO_BROWSER: "1",
      CONTEXTNEST_CONFIG_DIR: join(home, ".contextnest"),
      CONTEXTNEST_CREDENTIALS_BACKEND: "file",
      CONTEXTNEST_CREDENTIALS_KEY: "test-passphrase",
      CONTEXTNEST_NO_HINTS: "",
      CONTEXTNEST_VAULT: "",
      CONTEXTNEST_VAULT_PATH: "",
    };
    server.validKeys.clear();
    server.validKeys.add(KEY);
    server.validKeys.add(KEY2);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** Piped run: stderr is a pipe, like an agent or CI. */
  function ctx(args: string[], input = "", extra: Record<string, string> = {}): Promise<Run> {
    return new Promise((resolve) => {
      const child = execFile(
        "node",
        [distPath, ...args],
        { cwd: home, env: { ...env, ...extra }, encoding: "utf-8", timeout: 30_000 },
        (err, stdout, stderr) =>
          resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin?.end(input);
    });
  }

  /** Run under a pseudo-terminal, so stderr.isTTY is true. Output of both streams is merged. */
  function ctxTty(args: string[], extra: Record<string, string> = {}): Promise<Run> {
    const py = "import os,pty,sys;sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))";
    return new Promise((resolve) => {
      const child = execFile(
        "python3",
        ["-c", py, "node", distPath, ...args],
        { cwd: home, env: { ...env, ...extra }, encoding: "utf-8", timeout: 30_000 },
        (err, stdout, stderr) =>
          resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin?.end();
    });
  }

  const nestCacheFile = () => join(home, ".contextnest", "cache", "nests-po.json");
  const forgetNestCache = () => rmSync(nestCacheFile(), { force: true });
  const ageNestCache = () => {
    const cached = JSON.parse(readFileSync(nestCacheFile(), "utf-8"));
    writeFileSync(nestCacheFile(), JSON.stringify({ ...cached, at: 0 }));
  };
  const registry = () => {
    const p = join(home, ".contextnest", "config.yaml");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  };
  const vaultRows = async () => JSON.parse((await ctx(["vault", "list", "--json"])).stdout) as Array<Record<string, unknown>>;
  const aliasOfServer = async () =>
    (await vaultRows()).find((v) => v.kind === "remote" && !v.parent)?.alias as string | undefined;

  // ── new user ──────────────────────────────────────────────────────────────

  it("browser login registers the server as a server, with no key in config.yaml, and lists its nests", async () => {
    const login = await ctx(["login", server.url]);
    expect(login.status).toBe(0);
    expect(login.stdout).toMatch(/Registered "/);
    expect(login.stdout).toContain("ctx vault remove");
    expect(login.stdout).toContain("without --vault, ctx reads across all of them"); // first entry: becomes the default

    const reg = registry();
    expect(reg).toContain("scope: server");
    expect(reg).toContain(`${server.url}/mcp`);
    expect(reg).not.toMatch(/cnst_|token|auth:/);

    const alias = (await aliasOfServer())!;
    const rows = await vaultRows();
    expect(rows.find((v) => v.alias === alias)).toMatchObject({ kind: "remote", scope: "server" });
    expect(rows.map((v) => v.alias)).toEqual(expect.arrayContaining([`${alias}/alpha`, `${alias}/beta`]));
    expect(rows.find((v) => v.alias === `${alias}/alpha`)?.description).toBe("First nest");
    expect(rows.find((v) => v.alias === alias)?.isDefault).toBe(true); // the registry's rule: the first entry is the default
  });

  it("never takes the default from a vault the user already has", async () => {
    mkdirSync(join(home, ".contextnest"), { recursive: true });
    const vault = join(home, "mine");
    mkdirSync(join(vault, ".context"), { recursive: true });
    writeFileSync(join(vault, ".context", "config.yaml"), "name: mine\n");
    writeFileSync(join(home, ".contextnest", "config.yaml"), `version: 1\ndefault: mine\nvaults:\n  mine:\n    path: ${JSON.stringify(vault)}\n`);
    const login = await ctx(["login", server.url, "--key-stdin"], KEY);
    expect(login.status).toBe(0);
    expect(login.stdout).toContain("still uses your default vault");
    expect(registry()).toContain("default: mine");
  });

  it("--as names the alias, --no-register registers nothing, a nest key registers nothing on its own", async () => {
    expect((await ctx(["login", server.url, "--key-stdin", "--as", "work"], KEY)).status).toBe(0);
    expect(registry()).toMatch(/^\s{2}work:/m);

    rmSync(join(home, ".contextnest"), { recursive: true, force: true });
    const only = await ctx(["login", server.url, "--key-stdin", "--no-register"], KEY);
    expect(only.status).toBe(0);
    expect(registry()).not.toContain("remotes");
    expect(only.stdout).toContain("ctx vault add");

    const nest = await ctx(["login", server.url, "--nest", "n-alpha-0001", "--key-stdin"], KEY);
    expect(nest.status).toBe(0);
    expect(registry()).not.toContain("remotes");
    expect(nest.stdout).toContain("--vault <alias>/<nest>");
  });

  it("logging in twice does not duplicate; a second account registers separately; a taken alias gets -2", async () => {
    await ctx(["login", server.url, "--key-stdin", "--as", "po"], KEY);
    const again = await ctx(["login", server.url, "--key-stdin"], KEY);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('"po" already points at this server');
    expect(Object.keys((await vaultRows()).filter((v) => v.kind === "remote" && !v.parent))).toHaveLength(1);

    const second = await ctx(["login", server.url, "--key-stdin", "--account", "other"], KEY2);
    expect(second.status).toBe(0);
    expect(registry()).toMatch(/account: other/);
    expect((await vaultRows()).filter((v) => v.kind === "remote" && !v.parent)).toHaveLength(2);

    // The derived name is taken by the account login above, so the next one gets -2.
    const third = await ctx(["login", server.url, "--key-stdin", "--account", "third"], KEY2);
    expect(third.status).toBe(0);
    expect(registry()).toMatch(/^\s{2}127-0-0-1-\d+-2:/m);
  });

  // ── addressing ────────────────────────────────────────────────────────────

  it("--vault <alias>/<nest> reads one nest; --vault <alias> spans the server; a wrong nest lists the real ones", async () => {
    await ctx(["login", server.url, "--key-stdin", "--as", "po"], KEY);
    const one = await ctx(["--vault", "po/alpha", "list", "--json"]);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("in-n-alpha-0001");
    const all = await ctx(["--vault", "po", "list", "--json"]);
    expect(all.status).toBe(0);
    const bad = await ctx(["--vault", "po/gamma", "list", "--json"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/Available: po\/alpha, po\/beta/);
  });

  // ── re-authentication ─────────────────────────────────────────────────────

  it("a rejected key names the exact login command; `ctx login <alias>` signs in again and the next command works", async () => {
    await ctx(["login", server.url, "--key-stdin", "--as", "po"], KEY);
    server.validKeys.clear(); // the server no longer accepts the saved key
    server.validKeys.add(KEY2);

    const rejected = await ctx(["--vault", "po/alpha", "list", "--json"]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(`ctx login ${server.url}`);
    expect(rejected.stderr).not.toContain("<server>");

    forgetNestCache(); // a fresh listing (the cached nests are good for minutes)
    const listing = (await ctx(["vault", "list"])).stdout;
    expect(listing).toContain("key rejected");
    expect(listing).toContain(`ctx login ${server.url}`);

    const again = await ctx(["login", "po", "--key-stdin"], KEY2);
    expect(again.status).toBe(0);
    expect((await ctx(["--vault", "po/alpha", "list", "--json"])).status).toBe(0);
    expect(registry().match(/^\s{2}po:/gm)).toHaveLength(1); // re-login by alias adds no entry
  });

  it("an account-bound remote's error carries --account", async () => {
    await ctx(["login", server.url, "--key-stdin", "--account", "other", "--as", "po-o"], KEY2);
    server.validKeys.clear();
    const rejected = await ctx(["--vault", "po-o/alpha", "list", "--json"]);
    expect(rejected.stderr).toContain(`ctx login ${server.url} --account other`);
  });

  // ── server down ───────────────────────────────────────────────────────────

  it("a down server is listed as not answering (exit 0), and the old nests show once cached", async () => {
    await ctx(["login", server.url, "--key-stdin", "--as", "po"], KEY);
    await vaultRows(); // fills the nest cache
    ageNestCache(); // past its freshness, so the next listing probes
    await server.setDown(true);
    try {
      const res = await ctx(["vault", "list"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("not answering");
      expect(res.stdout).toContain("po/alpha"); // last known list
    } finally {
      await server.setDown(false);
    }
  });

  // ── housekeeping ──────────────────────────────────────────────────────────

  it("vault rename moves the alias (and its nests), keeping scope; login --list says what uses a key; logout says the alias stays", async () => {
    await ctx(["login", server.url, "--key-stdin", "--as", "po"], KEY);
    const renamed = await ctx(["vault", "rename", "po", "work", "--yes"]);
    expect(renamed.status).toBe(0);
    const rows = await vaultRows();
    expect(rows.map((v) => v.alias)).toEqual(expect.arrayContaining(["work", "work/alpha"]));
    expect(rows.find((v) => v.alias === "work")).toMatchObject({ scope: "server" });
    expect((await ctx(["vault", "rename", "po", "x", "--yes"])).status).not.toBe(0);

    expect((await ctx(["login", "--list"])).stdout).toContain("used by: work");
    const out = await ctx(["logout", server.url]);
    expect(out.stdout).toContain('Vault "work" is still registered');
  });

  it("a registry written before `scope` existed still lists and works (probed as before)", async () => {
    mkdirSync(join(home, ".contextnest"), { recursive: true });
    writeFileSync(
      join(home, ".contextnest", "config.yaml"),
      `version: 1\nvaults: {}\nremotes:\n  old:\n    transport: http\n    url: ${server.url}/mcp\n`,
    );
    await ctx(["login", server.url, "--key-stdin", "--no-register"], KEY);
    const rows = await vaultRows();
    expect(rows.map((v) => v.alias)).toEqual(expect.arrayContaining(["old", "old/alpha"]));
    expect((await ctx(["--vault", "old/beta", "list", "--json"])).stdout).toContain("in-n-beta-0002");
  });

  it("a server without nest_index is a plain single nest, even when marked as a server", async () => {
    server.setSingleNest(true);
    try {
      await ctx(["login", server.url, "--key-stdin", "--as", "solo"], KEY);
      const rows = await vaultRows();
      expect(rows.filter((v) => String(v.alias).startsWith("solo/"))).toHaveLength(0);
      expect((await ctx(["--vault", "solo", "list", "--json"])).status).toBe(0);
    } finally {
      server.setSingleNest(false);
    }
  });

  // ── existing user: the transition hint ────────────────────────────────────

  describe.skipIf(!HAS_PTY)("logged in before registration existed (hint)", () => {
    const HINT = /logged in to .* but no vault is registered/;

    beforeEach(async () => {
      // The previous behaviour: a key saved, nothing registered.
      expect((await ctx(["login", server.url, "--key-stdin", "--no-register"], KEY)).status).toBe(0);
    });

    it("prints on every command at a terminal, naming the command that fixes it", async () => {
      for (const args of [["vault", "list"], ["login", "--list"], ["doctor"]]) {
        if (args[0] === "login") continue; // login commands are the fix, not a bystander
        const res = await ctxTty(args);
        expect(res.stdout + res.stderr).toMatch(HINT);
        expect(res.stdout + res.stderr).toContain(`ctx vault add`);
        expect(res.stdout + res.stderr).toContain(`--url ${server.url}/mcp`);
      }
    });

    it("stays silent for pipes (agents, CI), --json, CI=1, and the commands that settle it", async () => {
      const piped = await ctx(["vault", "list"]);
      expect(piped.stdout + piped.stderr).not.toMatch(HINT);
      const json = await ctxTty(["vault", "list", "--json"]);
      expect(json.stdout + json.stderr).not.toMatch(HINT);
      const ci = await ctxTty(["vault", "list"], { CI: "1" });
      expect(ci.stdout + ci.stderr).not.toMatch(HINT);
      const logout = await ctxTty(["login", "--list"]);
      expect(logout.stdout + logout.stderr).not.toMatch(HINT);
    });

    it("can be switched off and on, by command or by environment", async () => {
      expect((await ctx(["hints", "off"])).status).toBe(0);
      expect((await ctxTty(["vault", "list"])).stdout).not.toMatch(HINT);
      expect((await ctx(["hints", "on"])).status).toBe(0);
      expect((await ctxTty(["vault", "list"])).stdout).toMatch(HINT);
      expect((await ctxTty(["vault", "list"], { CONTEXTNEST_NO_HINTS: "1" })).stdout).not.toMatch(HINT);
    });

    it("stops once the server is registered, and a second server is named on its own", async () => {
      const other = await startNestServer({ nests: NESTS, validKeys: [KEY2] });
      try {
        await ctx(["login", other.url, "--key-stdin", "--no-register"], KEY2);
        const both = (await ctxTty(["vault", "list"])).stdout;
        expect(both).toContain(server.url);
        expect(both).toContain(other.url);

        expect((await ctx(["vault", "add", "first", "--url", `${server.url}/mcp`, "--yes"])).status).toBe(0);
        expect(registry()).toContain("scope: server");
        const after = (await ctxTty(["vault", "list"])).stdout;
        expect(after).not.toContain(`logged in to ${server.url}`);
        expect(after).toContain(`logged in to ${other.url}`);
      } finally {
        await other.close();
      }
    });

    it("works for an upgraded user whose logins.json does not exist yet, and does not need it again", async () => {
      rmSync(join(home, ".contextnest", "logins.json"), { force: true });
      expect((await ctxTty(["vault", "list"])).stdout).toMatch(HINT);
      expect(existsSync(join(home, ".contextnest", "logins.json"))).toBe(true);
      expect(readFileSync(join(home, ".contextnest", "logins.json"), "utf-8")).not.toContain("cnst_");
    });
  });
});
