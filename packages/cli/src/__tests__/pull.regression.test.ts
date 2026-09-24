/**
 * [regression] `ctx pull` end to end: the compiled CLI pulls a recipe from a
 * nest served by the built MCP server over stdio into a local vault.
 *
 * Unit coverage of the plan/apply rules lives in pull.test.ts; this pins the
 * wiring — remote resolution, --dry-run writing nothing, lineage on disk, and
 * an idempotent second pull.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const serverEntry = join(here, "..", "..", "..", "mcp-server", "dist", "index.js");
const fixtureVault = join(here, "..", "..", "..", "..", "fixtures", "minimal-vault");

function run(configDir: string, cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [distPath, ...args], {
      cwd,
      env: {
        ...process.env,
        CONTEXTNEST_NO_BROWSER: "1",
        CONTEXTNEST_CONFIG_DIR: configDir,
        CONTEXTNEST_VAULT: "",
        CONTEXTNEST_VAULT_PATH: "",
      },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function writeNode(vault: string, id: string, frontmatter: string, body: string): void {
  const file = join(vault, `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\nstatus: published\n---\n\n${body}\n`, "utf-8");
}

describe("[regression] ctx pull — recipe from a stdio remote into a local vault", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-pull-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-pull-cwd-"));
    localVault = mkdtempSync(join(tmpdir(), "cn-pull-local-"));
    serverVault = mkdtempSync(join(tmpdir(), "cn-pull-server-"));
    cpSync(fixtureVault, localVault, { recursive: true });
    cpSync(fixtureVault, serverVault, { recursive: true });

    writeNode(
      serverVault,
      "nodes/recipes/recipe-e2e",
      "title: Recipe · E2E\ntype: document",
      [
        "# Recipe · E2E",
        "",
        "```yaml recipe",
        "id: e2e",
        "includes:",
        "  - from: nodes/org/method",
        "    to: nodes/methodologies/method",
        "files:",
        "  - from: nodes/org/stewards",
        "    to: stewards.example.yaml",
        "pack:",
        "  id: e2e-pack",
        "  include:",
        "    - nodes/methodologies/method",
        "```",
      ].join("\n"),
    );
    writeNode(serverVault, "nodes/org/method", "title: The Method\ntype: document\ntags:\n  - \"#methodology\"", "# The Method\n\nFive questions.");
    writeNode(
      serverVault,
      "nodes/org/stewards",
      "title: Stewards Template\ntype: document",
      "# Stewards\n\n```yaml\nversion: 1\nnest:\n  - email: a@example.com\n    role: reviewer\n```",
    );

    const yq = (s: string) => JSON.stringify(s);
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "version: 1",
        "default: local",
        "vaults:",
        "  local:",
        `    path: ${yq(localVault)}`,
        "remotes:",
        "  recipes:",
        "    transport: stdio",
        `    command: ${yq(process.execPath)}`,
        "    args:",
        `      - ${yq(serverEntry)}`,
        `      - ${yq(serverVault)}`,
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) rmSync(dir, { recursive: true, force: true });
  });

  it("--dry-run prints the plan and writes nothing", () => {
    const res = run(configDir, cwd, ["pull", "recipes", "--recipe", "e2e", "--vault", "local", "--dry-run", "--json"]);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(res.stdout.slice(res.stdout.indexOf("{"), res.stdout.lastIndexOf("}") + 1));
    expect(json.dry_run).toBe(true);
    expect(json.written).toEqual([]);
    expect(json.steps.map((s: any) => s.action)).toEqual(["create", "create", "create"]);
    expect(existsSync(join(localVault, "nodes", "methodologies", "method.md"))).toBe(false);
    expect(existsSync(join(localVault, "stewards.example.yaml"))).toBe(false);
  });

  it("pulls drafts with lineage, the template file and the pack", () => {
    const res = run(configDir, cwd, ["pull", "recipes", "--recipe", "e2e", "--vault", "local"]);
    expect(res.status, res.stderr).toBe(0);
    const method = readFileSync(join(localVault, "nodes", "methodologies", "method.md"), "utf-8");
    expect(method).toMatch(/status: draft/);
    expect(method).toContain("contextnest://recipes/nodes/org/method");
    expect(method).toContain("Five questions.");
    expect(readFileSync(join(localVault, "stewards.example.yaml"), "utf-8")).toContain("a@example.com");
    expect(existsSync(join(localVault, "packs", "e2e-pack.yml"))).toBe(true);
  });

  it("a second pull writes nothing new", () => {
    const res = run(configDir, cwd, ["pull", "recipes", "--recipe", "e2e", "--vault", "local", "--json"]);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(res.stdout.slice(res.stdout.indexOf("{"), res.stdout.lastIndexOf("}") + 1));
    expect(json.written).toEqual([]);
    expect(json.steps.map((s: any) => s.action)).toEqual(["up-to-date", "exists", "exists"]);
  });

  it("refuses a local vault as the source", () => {
    const res = run(configDir, cwd, ["pull", "local", "--recipe", "e2e", "--vault", "local"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/is a local vault/);
  });
});
