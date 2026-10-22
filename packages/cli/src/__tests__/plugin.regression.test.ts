/**
 * [regression] `ctx plugin` — Nest Plugins against a local vault, driven
 * through the built CLI like a user would. The plugin under test is a plain
 * ESM file (no SDK import needed at runtime — the host validates the
 * manifest), so the suite has no dependency on a published plugin package.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-cli-plugin-cfg-"));
// Plugin secrets go to the secure credential store (#169). Pin the encrypted
// file backend under a throwaway HOME so the suite never touches a real
// keychain and behaves the same on every CI runner.
const HOME_DIR = mkdtempSync(join(tmpdir(), "cn-cli-plugin-home-"));
afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(HOME_DIR, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  HOME: HOME_DIR,
  USERPROFILE: HOME_DIR,
  CONTEXTNEST_CREDENTIALS_BACKEND: "file",
  CONTEXTNEST_CREDENTIALS_KEY: "plugin-regression-passphrase",
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;
for (const k of Object.keys(ENV)) if (k.startsWith("CONTEXTNEST_PLUGIN_")) delete ENV[k];
/** No keyring and no CONTEXTNEST_CREDENTIALS_KEY: nowhere safe to keep a secret. */
const NO_STORE_ENV = { ...ENV, CONTEXTNEST_CREDENTIALS_BACKEND: "keyring", CONTEXTNEST_CREDENTIALS_KEY: "", DBUS_SESSION_BUS_ADDRESS: "" } as NodeJS.ProcessEnv;

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV) {
  const res = spawnSync("node", [distPath, ...args], { cwd, env, encoding: "utf-8" });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}
function ok(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = run(cwd, args, env);
  if (r.status !== 0) throw new Error(`ctx ${args.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const PLUGIN_SRC = `
let calls = 0;
export default {
  manifest: {
    name: "memo",
    version: "0.0.1",
    displayName: "Memo",
    description: "test plugin",
    capabilities: ["pull", "search"],
    itemKinds: ["document"],
    settings: { type: "object", required: ["prefix"], properties: { prefix: { type: "string" }, token: { type: "string", "x-secret": true } } },
  },
  pull(ctx, cursor) {
    const n = (cursor && cursor.n) || 0;
    const r = {
      nextCursor: cursor,
      async *[Symbol.asyncIterator]() {
        if (ctx.settings.token !== "sekrit") throw new Error("token not resolved: " + JSON.stringify(ctx.settings));
        if (n === 0) {
          yield { externalId: "m1", kind: "document", title: ctx.settings.prefix + " one", occurredAt: "2026-09-15T00:00:00Z", body: "first memo", provenance: { fetchedAt: "2026-09-15T00:00:00Z", hash: "a" } };
        }
        r.nextCursor = { n: n + 1 };
      },
    };
    return r;
  },
  async search(ctx, q) { return [{ title: "live " + q.text, snippet: "…", externalId: "live-1" }]; },
  async fetchOne(ctx, id) { return { externalId: id, kind: "document", title: "Promoted " + id, occurredAt: "2026-09-15T00:00:00Z", body: "promoted body", provenance: { fetchedAt: "2026-09-15T00:00:00Z", hash: "p" } }; },
};
`;

describe("[regression] ctx plugin", () => {
  let tmp: string;
  let pluginFile: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cn-cli-plugin-"));
    execFileSync("node", [distPath, "init", "--name", "plugin-vault", "--layout", "structured"], { cwd: tmp, env: ENV, stdio: "ignore" });
    mkdirSync(join(tmp, "plugins"));
    pluginFile = join(tmp, "plugins", "memo.mjs");
    writeFileSync(pluginFile, PLUGIN_SRC);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("add validates and records the plugin; list shows it; a bad module is refused with its reason", () => {
    const out = ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    expect(out).toMatch(/memo/);
    expect(existsSync(join(tmp, ".context", "plugins.yaml"))).toBe(true);
    expect(ok(tmp, ["plugin", "list"])).toMatch(/memo.*pull/s);
    writeFileSync(join(tmp, "plugins", "bad.mjs"), "export default { manifest: { name: 'Bad Name' } }");
    const bad = run(tmp, ["plugin", "add", "./plugins/bad.mjs"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr + bad.stdout).toMatch(/name/);
  });

  it("set stores settings; secrets are masked on list and resolvable from env; pull writes nodes and advances the cursor only on a clean run", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=sekrit"]);
    const listed = ok(tmp, ["plugin", "list", "--json"]);
    expect(listed).not.toContain("sekrit");
    expect(listed).toMatch(/••••/);
    const yaml = readFileSync(join(tmp, ".context", "plugins.yaml"), "utf-8");
    expect(yaml).not.toContain("sekrit"); // secrets go to the secure store, never plugins.yaml
    expect(yaml).toContain("prefix: Memo");
    expect(readFileSync(join(HOME_DIR, ".promptowl", "credentials.enc.json"), "utf-8")).not.toContain("sekrit");

    const pull = ok(tmp, ["plugin", "pull", "memo", "--json"]);
    const r = JSON.parse(pull);
    expect(r).toMatchObject({ created: 1, clean: true, nextCursor: { n: 1 } });
    expect(r.results[0].id).toMatch(/^nodes\/inbox\/memo\//); // structured vault → rooted under nodes/
    expect(ok(tmp, ["read", r.results[0].id])).toMatch(/first memo/);
    expect(ok(tmp, ["read", r.results[0].id])).toMatch(/Memo one/);
    expect(ok(tmp, ["list"])).toMatch(/Memo one/); // discoverable, not orphaned outside nodes/

    // second run: cursor advanced → plugin yields nothing
    const again = JSON.parse(ok(tmp, ["plugin", "pull", "memo", "--json"]));
    expect(again).toMatchObject({ created: 0, updated: 0, nextCursor: { n: 2 } });
  });

  it("list keeps secrets masked even when the plugin module no longer loads (regression: masking must not depend on a re-import)", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=sekrit"]);
    rmSync(join(tmp, "plugins", "memo.mjs"));
    const listed = ok(tmp, ["plugin", "list", "--json"]);
    expect(listed).not.toContain("sekrit");
    expect(listed).toMatch(/••••/);
    expect(listed).toMatch(/"error"/);
    expect(ok(tmp, ["plugin", "list"])).not.toContain("sekrit");
    writeFileSync(join(tmp, "plugins", "memo.mjs"), PLUGIN_SRC);
  });

  it("set keeps a string-typed setting a string even when the value looks like a number or boolean", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=12345", "token=true"]);
    const yaml = readFileSync(join(tmp, ".context", "plugins.yaml"), "utf-8");
    expect(yaml).toMatch(/prefix: ['"]12345['"]/);
    expect(yaml).not.toMatch(/token: /);
  });

  it("with no secure store, set refuses to write a secret in plaintext and names the env var; the env var alone still works", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    const r = run(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=sekrit"], NO_STORE_ENV);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/CONTEXTNEST_PLUGIN_MEMO_TOKEN/);
    expect(readFileSync(join(tmp, ".context", "plugins.yaml"), "utf-8")).not.toContain("sekrit");
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo"], NO_STORE_ENV);
    const pull = run(tmp, ["plugin", "pull", "memo", "--json"], { ...NO_STORE_ENV, CONTEXTNEST_PLUGIN_MEMO_TOKEN: "sekrit" });
    expect(pull.status).toBe(0);
    expect(JSON.parse(pull.stdout).created).toBe(1);
  });

  it("a plaintext secret left in plugins.yaml by an older ctx moves to the secure store on the next pull", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    const file = join(tmp, ".context", "plugins.yaml");
    const legacy = readFileSync(file, "utf-8").replace(/(\n\s+package: .*\n)/, "$1    settings:\n      prefix: Memo\n      token: sekrit\n");
    writeFileSync(file, legacy);
    expect(readFileSync(file, "utf-8")).toContain("token: sekrit");
    const r = JSON.parse(ok(tmp, ["plugin", "pull", "memo", "--json"]));
    expect(r.created).toBe(1);
    expect(readFileSync(file, "utf-8")).not.toContain("sekrit");
    // still resolvable from the store on the next run
    expect(JSON.parse(ok(tmp, ["plugin", "pull", "memo", "--json", "--reset"])).failed).toEqual([]);
  });

  it("remove also forgets the plugin's stored secrets", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=sekrit"]);
    ok(tmp, ["plugin", "remove", "memo", "--yes"]);
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo"]);
    const r = run(tmp, ["plugin", "pull", "memo", "--json"]);
    expect(JSON.parse(r.stdout).failed[0].error).toMatch(/token not resolved/);
  });

  it("an env var overrides a stored secret", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=wrong"]);
    const r = run(tmp, ["plugin", "pull", "memo", "--json"], { ...ENV, CONTEXTNEST_PLUGIN_MEMO_TOKEN: "sekrit" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).created).toBe(1);
  });

  it("search fans out to the plugin and promote lands the hit in the vault", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=sekrit"]);
    const s = JSON.parse(ok(tmp, ["plugin", "search", "sso", "--json"]));
    expect(s.live).toEqual([{ plugin: "memo", hits: [expect.objectContaining({ externalId: "live-1", governed: false })] }]);
    const p = JSON.parse(ok(tmp, ["plugin", "promote", "memo", "live-1", "--json"]));
    expect(p.outcome).toBe("created");
    expect(ok(tmp, ["read", p.id])).toMatch(/promoted body/);
  });

  it("remove forgets the plugin but leaves its nodes alone", () => {
    ok(tmp, ["plugin", "add", "./plugins/memo.mjs"]);
    ok(tmp, ["plugin", "set", "memo", "prefix=Memo", "token=sekrit"]);
    const r = JSON.parse(ok(tmp, ["plugin", "pull", "memo", "--json"]));
    ok(tmp, ["plugin", "remove", "memo", "--yes"]);
    expect(ok(tmp, ["plugin", "list"])).not.toMatch(/memo/);
    expect(ok(tmp, ["read", r.results[0].id])).toMatch(/first memo/);
  });

  it.each(["plugin add", "plugin set", "plugin remove", "plugin pull", "plugin promote", "plugin list", "plugin search"])("`ctx %s --help` exists", (name) => {
    const res = run(tmp, [...name.split(" "), "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage:/);
  });
});
