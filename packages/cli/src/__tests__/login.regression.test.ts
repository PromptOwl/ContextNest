/**
 * login.regression.test.ts — `ctx login` / `ctx logout` end to end, through
 * the compiled CLI (dist/index.js) and the encrypted-file credential store.
 *
 * Pins the multi-server contract: one machine holds keys for the public
 * hosted server, a self-hosted one, and nest-scoped keys at the same time;
 * nothing ever prints a key; a corrupt saved map is refused, never
 * overwritten, and `logout --all` is the way out.
 *
 * --key-stdin only: the browser flow is covered against a mock in login.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialStore } from "../credentials.js";
import { SERVERS_ACCOUNT } from "../server-credentials.js";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const HOSTED = "https://nest.promptowl.ai";
const SELF = "http://localhost:3737";
const KEY_HOSTED = "cnst_hosted_key_0001";
const KEY_SELF = "cnst_self_key_0002";
const KEY_NEST = "cnst_nest_key_0003";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

describe("ctx login / logout (regression)", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cn-login-"));
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CONTEXTNEST_NO_BROWSER: "1",
      CONTEXTNEST_CONFIG_DIR: join(home, ".contextnest"),
      CONTEXTNEST_CREDENTIALS_BACKEND: "file",
      CONTEXTNEST_CREDENTIALS_KEY: "test-passphrase",
      CONTEXTNEST_VAULT: "",
      CONTEXTNEST_VAULT_PATH: "",
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function ctx(args: string[], input = ""): RunResult {
    try {
      const stdout = execFileSync("node", [distPath, ...args], {
        cwd: home,
        env,
        input,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err: any) {
      return {
        status: typeof err.status === "number" ? err.status : 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  }

  const store = () => new CredentialStore({ home, env, keyring: null });

  function loginAll(): void {
    expect(ctx(["login", HOSTED, "--key-stdin"], `${KEY_HOSTED}\n`).status).toBe(0);
    expect(ctx(["login", SELF, "--key-stdin"], `  ${KEY_SELF}  \n`).status).toBe(0);
    const scoped = ctx(["login", HOSTED, "--nest", "n1", "--key-stdin"], KEY_NEST);
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain(`${HOSTED}/nests/n1`);
    expect(scoped.stdout).toContain("this nest only");
  }

  it("holds hosted, self-hosted and nest-scoped keys at once, and --list never prints a key", () => {
    loginAll();
    const list = ctx(["login", "--list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(HOSTED);
    expect(list.stdout).toContain(SELF);
    expect(list.stdout).toContain(`${HOSTED}/nests/n1`);
    expect(list.stdout).toMatch(/nest\.promptowl\.ai\s+\(default\)/);
    expect(list.stdout).not.toContain("cnst_");

    const onlyHosted = ctx(["login", "--list", HOSTED]);
    expect(onlyHosted.stdout).toContain(`${HOSTED}/nests/n1`);
    expect(onlyHosted.stdout).not.toContain(SELF);
  });

  it("refuses --nest with the browser flow (that key would be server-wide)", () => {
    const r = ctx(["login", HOSTED, "--nest", "n1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--key-stdin");
  });

  it("logout --nest drops one scope; logout <server> drops the server and its scopes; others survive", () => {
    loginAll();
    expect(ctx(["logout", HOSTED, "--nest", "n1"]).stdout).toContain(`Logged out of ${HOSTED}/nests/n1`);
    let list = ctx(["login", "--list"]).stdout;
    expect(list).not.toContain("/nests/n1");
    expect(list).toContain(HOSTED);

    expect(ctx(["login", HOSTED, "--nest", "n1", "--key-stdin"], KEY_NEST).status).toBe(0);
    const out = ctx(["logout", HOSTED]).stdout;
    expect(out).toContain(`Logged out of ${HOSTED}.`);
    expect(out).toContain(`Logged out of ${HOSTED}/nests/n1.`);
    list = ctx(["login", "--list"]).stdout;
    expect(list).not.toContain("promptowl");
    expect(list).toMatch(/localhost:3737\s+\(default\)/);

    expect(ctx(["logout", "https://unknown.example.com"]).stdout).toContain("No saved key");
    expect(ctx(["logout", "--all"]).stdout).toContain(`Logged out of ${SELF}`);
    expect(ctx(["logout", "--all"]).stdout).toContain("No saved server keys.");
    expect(ctx(["login", "--list"]).stdout).toContain("Not logged in");
  });

  it("a corrupt saved map is refused and left alone; logout --all resets it", async () => {
    loginAll();
    await store().set(SERVERS_ACCOUNT, "{corrupt");

    const list = ctx(["login", "--list"]);
    expect(list.status).toBe(1);
    expect(list.stderr).toContain("logout --all");
    const again = ctx(["login", SELF, "--key-stdin"], KEY_SELF);
    expect(again.status).toBe(1);
    expect(await store().get(SERVERS_ACCOUNT)).toBe("{corrupt");

    expect(ctx(["logout", "--all"]).status).toBe(0);
    expect(ctx(["login", SELF, "--key-stdin"], KEY_SELF).status).toBe(0);
    expect(ctx(["login", "--list"]).stdout).toContain(SELF);
  });
});
