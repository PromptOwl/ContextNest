/**
 * [regression] Structure rules through the built CLI (dist/index.js):
 * `ctx structure` reads them (local and, shape-identically, remote over the
 * built MCP server), and every write command is refused, prefilled or
 * scaffolded by the engine the same way the operation suites pin.
 *
 * Written test-first for docs/prds/structure-rules.md (Community repo) — the
 * engine phase. Run with `pnpm test:regression` (builds first).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NestStorage, setStructure, type StructureConfig } from "@promptowl/contextnest-engine";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const serverEntry = join(here, "..", "..", "..", "mcp-server", "dist", "index.js");
const fixtureVault = join(here, "..", "..", "..", "..", "fixtures", "minimal-vault");

const RULES: StructureConfig = {
  structure: { enforce: true, closed: true },
  folders: {
    "/": {},
    "clients/{client}": {
      folder_name: "/[a-z]+-[0-9]{3}/",
      types: ["document"],
      files: { overview: { template: "client-overview" } },
    },
    "clients/{client}/meetings": {
      required: true,
      types: ["document"],
      file_name: "{date}-{slug}",
      template: "meeting-note",
    },
    "clients/{client}/contracts": { required: true, types: ["pdf"] },
  },
  templates: {
    "meeting-note": {
      body: "## Attendees\n## Decisions\n## Action items\n",
      required_sections: ["Decisions", "Action items"],
    },
    "client-overview": { body: "## Summary\n## Contacts\n" },
  },
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function makeRunner(configDir: string) {
  const env = {
    ...process.env,
    CONTEXTNEST_NO_BROWSER: "1",
    CONTEXTNEST_CONFIG_DIR: configDir,
    CONTEXTNEST_VAULT: "",
    CONTEXTNEST_VAULT_PATH: "",
  } as NodeJS.ProcessEnv;
  return (cwd: string, args: string[]): RunResult => {
    try {
      const stdout = execFileSync("node", [distPath, ...args], {
        cwd,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err: any) {
      return {
        status: typeof err.status === "number" ? err.status : 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  };
}

/** Sort object keys and arrays-of-objects so two vault copies compare equal. */
function normalized(jsonText: string): unknown {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const mapped = v.map(sortDeep);
      if (mapped.every((m) => m && typeof m === "object" && !Array.isArray(m))) {
        const key = (o: any) => String(o.pattern ?? o.path ?? o.id ?? JSON.stringify(o));
        return [...mapped].sort((a, b) => key(a).localeCompare(key(b)));
      }
      return mapped;
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, sortDeep(val)]),
      );
    }
    return v;
  };
  return sortDeep(JSON.parse(jsonText));
}

// ─── Local vault ────────────────────────────────────────────────────────────

describe("[regression] structure rules — ctx on a local vault", () => {
  let configDir: string;
  let vault: string;
  let run: ReturnType<typeof makeRunner>;
  const ctx = (args: string[]) => run(vault, args);

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-structure-cfg-"));
    vault = mkdtempSync(join(tmpdir(), "cn-structure-vault-"));
    run = makeRunner(configDir);
    const init = ctx(["init", "--name", "structure-vault", "--layout", "structured"]);
    expect(init.status, init.stderr).toBe(0);
    expect(ctx(["config", "set", "review", "off"]).status).toBe(0);
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  });

  it("ctx structure --json on a vault without rules: empty and report-only", () => {
    const res = ctx(["structure", "--json"]);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ enforce: false, closed: false, folders: [], templates: {} });
  });

  it("ctx structure --json and --folder read the rules back", async () => {
    await setStructure(new NestStorage(vault), RULES);
    const all = JSON.parse(ctx(["structure", "--json"]).stdout);
    expect(all.enforce).toBe(true);
    expect(all.folders.map((f: any) => f.pattern)).toContain("clients/{client}/meetings");

    const res = ctx(["structure", "--folder", "nodes/clients/acme-042/meetings", "--json"]);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).resolved).toMatchObject({
      pattern: "clients/{client}/meetings",
      file_name: "{date}-{slug}",
      template_body: "## Attendees\n## Decisions\n## Action items\n",
      required_sections: ["Decisions", "Action items"],
    });
  });

  it("ctx structure prints a readable blueprint", async () => {
    await setStructure(new NestStorage(vault), RULES);
    const res = ctx(["structure"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/enforced/i);
    expect(res.stdout).toContain("clients/{client}/meetings");
    expect(res.stdout).toContain("{date}-{slug}");
  });

  it("ctx add into an undeclared folder is refused with the rule, and nothing is written", async () => {
    await setStructure(new NestStorage(vault), RULES);
    const res = ctx(["add", "nodes/notes/idea", "--title", "Idea"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("VALIDATION_FAILED");
    expect(res.stderr).toMatch(/"notes\/" is not an allowed folder/);
    expect(existsSync(join(vault, "nodes", "notes", "idea.md"))).toBe(false);
  });

  it("ctx add without --body starts from the folder's template and scaffolds the client folder", async () => {
    await setStructure(new NestStorage(vault), RULES);
    const res = ctx(["add", "nodes/clients/acme-042/meetings/2026-10-07-kickoff", "--title", "2026-10-07 Kickoff"]);
    expect(res.status, res.stderr).toBe(0);
    const doc = readFileSync(join(vault, "nodes", "clients", "acme-042", "meetings", "2026-10-07-kickoff.md"), "utf-8");
    expect(doc).toContain("## Decisions");
    expect(doc).toContain("## Action items");
    expect(existsSync(join(vault, "nodes", "clients", "acme-042", "overview.md"))).toBe(true);
    expect(existsSync(join(vault, "nodes", "clients", "acme-042", "contracts"))).toBe(true);
  });

  it("ctx add with a name that misses the format explains the expected shape", async () => {
    await setStructure(new NestStorage(vault), RULES);
    const res = ctx(["add", "nodes/clients/acme-042/meetings/kickoff", "--title", "Kickoff"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("{date}-{slug}");
  });

  it("ctx delete of a required file is refused", async () => {
    await setStructure(new NestStorage(vault), RULES);
    ctx(["add", "nodes/clients/acme-042/meetings/2026-10-07-kickoff", "--title", "2026-10-07 Kickoff"]);
    const res = ctx(["delete", "nodes/clients/acme-042/overview", "--yes"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/delete the folder instead/);
    expect(existsSync(join(vault, "nodes", "clients", "acme-042", "overview.md"))).toBe(true);
  });

  it("ctx structure --report --json lists content that predates the rules", async () => {
    expect(ctx(["add", "nodes/notes/old", "--title", "Old"]).status).toBe(0);
    await setStructure(new NestStorage(vault), RULES);
    const res = ctx(["structure", "--report", "--json"]);
    expect(res.status, res.stderr).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.violations).toContainEqual(
      expect.objectContaining({ code: "FOLDER_NOT_ALLOWED", path: "notes" }),
    );
    // Grandfathered: still editable.
    expect(ctx(["update", "nodes/notes/old", "--body", "edited"]).status).toBe(0);
  });

  it("a bad rule fails writes with CONFIG_ERROR naming the key; reads still work", () => {
    const cfg = join(vault, ".context", "config.yaml");
    writeFileSync(cfg, `${readFileSync(cfg, "utf-8")}\nfolders:\n  d:\n    file_name: "/(a+)+/"\n`);
    const res = ctx(["add", "nodes/x", "--title", "X"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("CONFIG_ERROR");
    expect(res.stderr).toContain("folders.d.file_name");
    expect(ctx(["list", "--json"]).status).toBe(0);
  });
});

// ─── Remote parity ──────────────────────────────────────────────────────────

describe("[regression] structure rules — ctx structure over a remote nest", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "cn-structure-remote-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-structure-remote-cwd-"));
    localVault = mkdtempSync(join(tmpdir(), "cn-structure-remote-local-"));
    serverVault = mkdtempSync(join(tmpdir(), "cn-structure-remote-server-"));
    for (const v of [localVault, serverVault]) {
      cpSync(fixtureVault, v, { recursive: true });
      await setStructure(new NestStorage(v), RULES);
    }
    const yq = (s: string) => JSON.stringify(s);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "version: 1",
        "default: local",
        "vaults:",
        "  local:",
        `    path: ${yq(localVault)}`,
        "remotes:",
        "  farnest:",
        "    transport: stdio",
        `    command: ${yq(process.execPath)}`,
        "    args:",
        `      - ${yq(serverEntry)}`,
        `      - ${yq(serverVault)}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    run = makeRunner(configDir);
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) rmSync(dir, { recursive: true, force: true });
  });

  it("ctx structure --report --json is shape-identical between local and remote", () => {
    const local = run(cwd, ["structure", "--report", "--json", "--vault", "local"]);
    expect(local.status, local.stderr).toBe(0);
    const remote = run(cwd, ["structure", "--report", "--json", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("ctx structure --folder --json is shape-identical between local and remote", () => {
    const args = ["structure", "--folder", "clients/acme-042/meetings", "--json"];
    const local = run(cwd, [...args, "--vault", "local"]);
    const remote = run(cwd, [...args, "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("the remote nest enforces the rules on ctx add", () => {
    const res = run(cwd, ["add", "nodes/notes/idea", "--title", "Idea", "--vault", "farnest"]);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/not an allowed folder/);
    expect(existsSync(join(serverVault, "nodes", "notes", "idea.md"))).toBe(false);
  });
});
