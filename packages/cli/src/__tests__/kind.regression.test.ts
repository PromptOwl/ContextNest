/**
 * [regression] `ctx kind apply` gates in the compiled CLI: an unreviewed
 * (draft) kind is never applied by --yes alone, and the kind id can't reach
 * outside nodes/kinds/. Both refusals happen before any request is sent, so
 * the server here is a port nothing listens on.
 *
 * The last block runs the CLI against a local HTTP server: what --json and
 * the exit code say when a request fails, and that the key stays off the
 * output. Plan/execute behaviour in detail lives in kind.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const fixtureVault = join(here, "..", "..", "..", "..", "fixtures", "minimal-vault");
const DEAD_SERVER = "http://127.0.0.1:9";

let vault: string;
let configDir: string;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [distPath, ...args], {
      cwd: vault,
      env: {
        ...process.env,
        CONTEXTNEST_NO_BROWSER: "1",
        CONTEXTNEST_CONFIG_DIR: configDir,
        CONTEXTNEST_VAULT: "",
        CONTEXTNEST_VAULT_PATH: "",
        CONTEXTNEST_API_KEY: "cnst_regression",
      },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function writeKind(id: string, status: "draft" | "published"): void {
  const file = join(vault, "nodes", "kinds", `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  const section = { edge_types: [{ name: "escalates-when", description: "Escalate." }] };
  writeFileSync(
    file,
    `---\ntitle: Kind ${id}\ntype: document\nstatus: ${status}\n---\n\n` +
      "```yaml kind\n" +
      JSON.stringify(section, null, 2) +
      "\n```\n",
    "utf-8",
  );
}

const apply = (id: string, ...extra: string[]) =>
  run(["kind", "apply", id, "--server", DEAD_SERVER, "--nest", "n1", ...extra]);

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "cn-kind-vault-"));
  configDir = mkdtempSync(join(tmpdir(), "cn-kind-cfg-"));
  cpSync(fixtureVault, vault, { recursive: true });
  writeKind("drafty", "draft");
  writeKind("ready", "published");
});

afterAll(() => {
  for (const dir of [vault, configDir]) rmSync(dir, { recursive: true, force: true });
});

describe("[regression] ctx kind apply — gates", () => {
  it("refuses --yes on a draft kind before sending anything", () => {
    const res = apply("drafty", "--yes");
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/nodes\/kinds\/drafty is draft, not published — refusing to apply an unreviewed kind/);
    expect(res.stderr).toMatch(/--allow-draft/);
  });

  it("--allow-draft passes the gate (and then needs a reachable server)", () => {
    const res = apply("drafty", "--yes", "--allow-draft");
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toMatch(/refusing to apply/);
  });

  it("a published kind passes the gate with --yes alone", () => {
    const res = apply("ready", "--yes");
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toMatch(/refusing to apply/);
  });

  it("rejects a kind id that isn't a plain name", () => {
    const res = apply("../drafty");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/must be a plain name/);
  });
});

describe("[regression] ctx kind apply — against a server", () => {
  let server: Server;
  let url: string;
  const auth: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      auth.push(String(req.headers.authorization));
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/nests/n1") return reply(200, { id: "n1" });
      if (req.method === "GET" && req.url === "/nests/n1/edge-types") return reply(200, { edge_types: [] });
      if (req.method === "POST" && req.url === "/nests/n1/edge-types") return reply(500, { error: "boom" });
      reply(404, { error: "Not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // Async: the server lives in this process, so a sync spawn would block it.
  const applyAsync = (...args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        "node",
        [distPath, "kind", "apply", "ready", "--server", url, "--nest", "n1", ...args],
        {
          cwd: vault,
          env: { ...process.env, CONTEXTNEST_NO_BROWSER: "1", CONTEXTNEST_CONFIG_DIR: configDir, CONTEXTNEST_VAULT: "", CONTEXTNEST_VAULT_PATH: "", CONTEXTNEST_API_KEY: "cnst_regression" },
          encoding: "utf-8",
        },
        (err, stdout, stderr) => resolve({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  it("--json --yes: a failed request is in the JSON, the exit code is 1, and the key never prints", async () => {
    const res = await applyAsync("--yes", "--json");
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.dry_run).toBe(false);
    expect(out.steps).toEqual([expect.objectContaining({ kind: "edge-type", result: "failed", error: "500 boom" })]);
    expect(auth.every((a) => a === "Bearer cnst_regression")).toBe(true);
    expect(res.stdout + res.stderr).not.toContain("cnst_regression");
  });

  it("a dry run exits 0 and says nothing was sent", async () => {
    const res = await applyAsync();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Dry run — 1 request\(s\) planned, nothing sent/);
  });
});
