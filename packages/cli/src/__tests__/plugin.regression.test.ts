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
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));
const ENV = { ...process.env, CONTEXTNEST_NO_BROWSER: "1", CONTEXTNEST_CONFIG_DIR: CONFIG_DIR, CONTEXTNEST_VAULT: "", CONTEXTNEST_VAULT_PATH: "" } as NodeJS.ProcessEnv;

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
    expect(yaml).toContain("sekrit"); // stored locally, file is the operator's to protect

    const pull = ok(tmp, ["plugin", "pull", "memo", "--json"]);
    const r = JSON.parse(pull);
    expect(r).toMatchObject({ created: 1, clean: true, nextCursor: { n: 1 } });
    expect(ok(tmp, ["read", r.results[0].id])).toMatch(/first memo/);
    expect(ok(tmp, ["read", r.results[0].id])).toMatch(/Memo one/);

    // second run: cursor advanced → plugin yields nothing
    const again = JSON.parse(ok(tmp, ["plugin", "pull", "memo", "--json"]));
    expect(again).toMatchObject({ created: 0, updated: 0, nextCursor: { n: 2 } });
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
