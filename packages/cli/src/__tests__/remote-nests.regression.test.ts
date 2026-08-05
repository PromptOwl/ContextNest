/**
 * [regression] TDD contract suite — local + remote nests through the ctx CLI.
 *
 * Written test-first for docs/plans/remote-nests-mcp-integration.md (§3
 * registry `remotes:` map, §4 remote backend, §5 CLI routing): these tests
 * encode the TARGET contract and are expected to FAIL until the feature
 * lands.
 *
 * Contract under test:
 *  1. Registration UX — `ctx vault add` grows remote flags (--url /
 *     --bearer-env for HTTP, --mcp-command / --mcp-arg for stdio); remotes are
 *     stored in a top-level `remotes:` map in the registry (never inside
 *     `vaults:`, so older CLIs skip them instead of failing to parse);
 *     `vault list --json` reports kind local|remote; one alias namespace
 *     across both maps; secrets are stored as env-var *references*, never
 *     values.
 *  2. Routing — `--vault <remote-alias>` transparently drives read AND write
 *     commands against a nest served by the built contextnest-mcp over stdio,
 *     with `--json` output byte-shape-identical to a local vault (the
 *     invariant that keeps the plugins unchanged).
 *  3. Guardrails — inherently local commands fail fast with a clear message
 *     on a remote alias; an unreachable remote exits with code 3 naming the
 *     alias (so plugin hooks can skip silently instead of surfacing noise).
 *
 * Like cli.regression.test.ts, this spawns the compiled CLI (dist/index.js);
 * the remote tests additionally rely on the built MCP server
 * (packages/mcp-server/dist/index.js) as the stdio remote — both are built by
 * `pnpm test:regression`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  mkdirSync,
} from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");
const serverEntry = join(here, "..", "..", "..", "mcp-server", "dist", "index.js");
const fixtureVault = join(here, "..", "..", "..", "..", "fixtures", "minimal-vault");

/** Exit code contract for "the remote exists but could not be reached". */
const REMOTE_UNREACHABLE_EXIT = 3;

// ─── Runners ────────────────────────────────────────────────────────────────

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

  return (cwd: string, args: string[], extraEnv: Record<string, string> = {}): RunResult => {
    try {
      const stdout = execFileSync("node", [distPath, ...args], {
        cwd,
        env: { ...env, ...extraEnv },
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

/** Quote a value for hand-written YAML (handles Windows backslashes). */
function yq(s: string): string {
  return JSON.stringify(s);
}

/** Copy the shared fixture vault into a throwaway directory. */
function freshVault(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixtureVault, dir, { recursive: true });
  return dir;
}

/**
 * Hand-write a registry with one local vault and one stdio remote pointing at
 * the built MCP server serving `serverVaultPath`. Writing the file directly
 * (rather than via `vault add`) pins the on-disk config contract itself.
 */
function writeRegistryWithStdioRemote(
  configDir: string,
  localVaultPath: string,
  serverVaultPath: string,
  remoteAlias = "farnest",
): void {
  const yaml = [
    "version: 1",
    "default: local",
    "vaults:",
    "  local:",
    `    path: ${yq(localVaultPath)}`,
    "remotes:",
    `  ${remoteAlias}:`,
    "    transport: stdio",
    `    command: ${yq(process.execPath)}`,
    "    args:",
    `      - ${yq(serverEntry)}`,
    `      - ${yq(serverVaultPath)}`,
    "    description: Fixture nest served over stdio",
    "",
  ].join("\n");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), yaml, "utf-8");
}

/** Find a TCP port with nothing listening on it. */
async function closedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

/** Normalize JSON output for local↔remote parity comparison. */
function normalized(jsonText: string): unknown {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const mapped = v.map(sortDeep);
      // Sort object arrays by id/alias when present so fs discovery order
      // differences between the two vault copies can't fail parity.
      if (mapped.every((m) => m && typeof m === "object" && !Array.isArray(m))) {
        const key = (o: any) => String(o.id ?? o.alias ?? JSON.stringify(o));
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

// ─── 1. Registration UX ─────────────────────────────────────────────────────

describe("[regression] remote nests — vault registry registration", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-cwd-"));
    localVault = freshVault("cn-remote-localvault-");
    run = makeRunner(configDir);
    // Seed one local alias so collision + list tests have both kinds.
    const added = run(cwd, ["vault", "add", "local", localVault]);
    expect(added.status, added.stderr).toBe(0);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(localVault, { recursive: true, force: true });
  });

  it("registers an HTTP remote with --url and --bearer-env", () => {
    const res = run(cwd, [
      "vault",
      "add",
      "team",
      "--url",
      "https://nest.example.com/mcp",
      "--bearer-env",
      "CN_TEAM_TOKEN",
      "--description",
      "Team shared nest",
    ]);
    expect(res.status, res.stderr).toBe(0);

    const registry = readFileSync(join(configDir, "config.yaml"), "utf-8");
    // Stored under the top-level `remotes:` map (older CLIs strip unknown
    // top-level keys, so this must never live inside `vaults:`).
    expect(registry).toMatch(/^remotes:/m);
    expect(registry).toContain("team:");
    expect(registry).toContain("https://nest.example.com/mcp");
    expect(registry).toContain("CN_TEAM_TOKEN");
    // The `vaults:` map keeps only path-shaped entries — the endpoint must
    // live in `remotes:`, not inside the vaults block.
    const vaultsBlock = registry.slice(
      registry.indexOf("vaults:"),
      registry.indexOf("remotes:"),
    );
    expect(vaultsBlock).not.toContain("url:");
  });

  it("never stores secret VALUES — only env-var references", () => {
    const res = run(
      cwd,
      [
        "vault",
        "add",
        "team",
        "--url",
        "https://nest.example.com/mcp",
        "--bearer-env",
        "CN_TEAM_TOKEN",
      ],
      { CN_TEAM_TOKEN: "cnst_super_secret_value" },
    );
    expect(res.status, res.stderr).toBe(0);
    const registry = readFileSync(join(configDir, "config.yaml"), "utf-8");
    expect(registry).not.toContain("cnst_super_secret_value");
  });

  it("registers a stdio remote with --mcp-command and repeated --mcp-arg", () => {
    const res = run(cwd, [
      "vault",
      "add",
      "research",
      "--mcp-command",
      process.execPath,
      "--mcp-arg",
      serverEntry,
      "--mcp-arg",
      localVault,
    ]);
    expect(res.status, res.stderr).toBe(0);

    const list = run(cwd, ["vault", "list", "--json"]);
    expect(list.status, list.stderr).toBe(0);
    const entries = JSON.parse(list.stdout) as Array<Record<string, unknown>>;
    const research = entries.find((e) => e.alias === "research");
    expect(research).toBeTruthy();
    expect(research!.kind).toBe("remote");
    expect(research!.transport).toBe("stdio");
  });

  it("vault list --json reports kind for both local and remote entries", () => {
    const added = run(cwd, [
      "vault",
      "add",
      "team",
      "--url",
      "https://nest.example.com/mcp",
    ]);
    expect(added.status, added.stderr).toBe(0);

    const list = run(cwd, ["vault", "list", "--json"]);
    expect(list.status, list.stderr).toBe(0);
    const entries = JSON.parse(list.stdout) as Array<Record<string, unknown>>;

    const local = entries.find((e) => e.alias === "local");
    expect(local).toBeTruthy();
    expect(local!.kind).toBe("local");

    const team = entries.find((e) => e.alias === "team");
    expect(team).toBeTruthy();
    expect(team!.kind).toBe("remote");
    expect(team!.transport).toBe("http");
  });

  it("rejects a remote alias that collides with an existing local alias", () => {
    const res = run(cwd, ["vault", "add", "local", "--url", "https://nest.example.com/mcp"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/already exists/i);
  });

  it("rejects a local alias that collides with an existing remote alias", () => {
    const remote = run(cwd, ["vault", "add", "team", "--url", "https://nest.example.com/mcp"]);
    expect(remote.status, remote.stderr).toBe(0);
    const other = freshVault("cn-remote-collide-");
    try {
      const res = run(cwd, ["vault", "add", "team", other]);
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toMatch(/already exists/i);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("vault remove deletes a remote entry", () => {
    const added = run(cwd, ["vault", "add", "team", "--url", "https://nest.example.com/mcp"]);
    expect(added.status, added.stderr).toBe(0);
    const removed = run(cwd, ["vault", "remove", "team"]);
    expect(removed.status, removed.stderr).toBe(0);
    const registry = readFileSync(join(configDir, "config.yaml"), "utf-8");
    expect(registry).not.toContain("nest.example.com");
  });

  it("a remote alias may become the registry default", () => {
    const added = run(cwd, ["vault", "add", "team", "--url", "https://nest.example.com/mcp"]);
    expect(added.status, added.stderr).toBe(0);
    const res = run(cwd, ["vault", "default", "team"]);
    expect(res.status, res.stderr).toBe(0);
    const registry = readFileSync(join(configDir, "config.yaml"), "utf-8");
    expect(registry).toMatch(/^default: team$/m);
  });

  it("vault which on a remote alias shows kind and endpoint", () => {
    const added = run(cwd, ["vault", "add", "team", "--url", "https://nest.example.com/mcp"]);
    expect(added.status, added.stderr).toBe(0);
    const which = run(cwd, ["vault", "which", "--vault", "team"]);
    expect(which.status, which.stderr).toBe(0);
    expect(which.stdout).toMatch(/remote/i);
    expect(which.stdout).toContain("https://nest.example.com/mcp");
  });

  it("rejects a registry entry carrying a raw secret instead of an env reference", () => {
    const yaml = [
      "version: 1",
      "vaults: {}",
      "remotes:",
      "  bad:",
      "    transport: http",
      "    url: https://nest.example.com/mcp",
      "    auth:",
      "      bearer: cnst_raw_secret_in_file",
      "",
    ].join("\n");
    writeFileSync(join(configDir, "config.yaml"), yaml, "utf-8");
    const res = run(cwd, ["vault", "list"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/bearer_env|env/i);
  });
});

// ─── 2. Remote routing — read surface over stdio ────────────────────────────

describe("[regression] remote nests — read surface routed over stdio MCP", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-read-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-read-cwd-"));
    // Two identical fixture copies: `local` is served from disk, `farnest`
    // through the built MCP server — outputs must match exactly.
    localVault = freshVault("cn-remote-read-local-");
    serverVault = freshVault("cn-remote-read-server-");
    writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    run = makeRunner(configDir);
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx list --json is shape-identical between local and remote", () => {
    const local = run(cwd, ["list", "--json", "--vault", "local"]);
    expect(local.status, local.stderr).toBe(0);
    const remote = run(cwd, ["list", "--json", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("ctx query --json is shape-identical between local and remote", () => {
    const local = run(cwd, ["query", "#engineering", "--json", "--vault", "local"]);
    expect(local.status, local.stderr).toBe(0);
    const remote = run(cwd, ["query", "#engineering", "--json", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("ctx search --json is shape-identical between local and remote", () => {
    const local = run(cwd, ["search", "API", "--json", "--vault", "local"]);
    expect(local.status, local.stderr).toBe(0);
    const remote = run(cwd, ["search", "API", "--json", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("ctx read --raw returns the document content from the remote nest", () => {
    const res = run(cwd, ["read", "nodes/api-design", "--raw", "--vault", "farnest"]);
    expect(res.status, res.stderr).toBe(0);
    const onDisk = readFileSync(join(serverVault, "nodes", "api-design.md"), "utf-8");
    // Normalize CRLF so the assertion holds on Windows checkouts.
    const strip = (s: string) => s.replace(/\r\n/g, "\n").trim();
    expect(strip(res.stdout)).toBe(strip(onDisk));
  });

  it("ctx verify --json works against the remote nest", () => {
    const res = run(cwd, ["verify", "--json", "--vault", "farnest"]);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(res.stdout) as { valid: boolean };
    expect(json.valid).toBe(true);
  });
});

// ─── 3. Guardrails ──────────────────────────────────────────────────────────

describe("[regression] remote nests — guardrails", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-guard-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-guard-cwd-"));
    localVault = freshVault("cn-remote-guard-local-");
    serverVault = freshVault("cn-remote-guard-server-");
    writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    run = makeRunner(configDir);
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("local-only commands fail fast with a clear message on a remote alias", () => {
    const res = run(cwd, ["index", "--vault", "farnest"]);
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBe(REMOTE_UNREACHABLE_EXIT); // config error, not connectivity
    expect(res.stderr + res.stdout).toMatch(/remote/i);
    expect(res.stderr + res.stdout).toMatch(/farnest/);
  });

  it("an unreachable HTTP remote exits with code 3 and names the alias", async () => {
    const port = await closedPort();
    const yaml = [
      "version: 1",
      "vaults: {}",
      "remotes:",
      "  deadhttp:",
      "    transport: http",
      `    url: http://127.0.0.1:${port}/mcp`,
      "",
    ].join("\n");
    writeFileSync(join(configDir, "config.yaml"), yaml, "utf-8");
    try {
      const res = run(cwd, ["list", "--json", "--vault", "deadhttp"]);
      expect(res.status).toBe(REMOTE_UNREACHABLE_EXIT);
      expect(res.stderr).toMatch(/deadhttp/);
    } finally {
      writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    }
  });

  it("a stdio remote whose process dies exits with code 3 and names the alias", () => {
    const yaml = [
      "version: 1",
      "vaults: {}",
      "remotes:",
      "  deadstdio:",
      "    transport: stdio",
      `    command: ${yq(process.execPath)}`,
      "    args:",
      `      - ${yq("-e")}`,
      `      - ${yq("process.exit(1)")}`,
      "",
    ].join("\n");
    writeFileSync(join(configDir, "config.yaml"), yaml, "utf-8");
    try {
      const res = run(cwd, ["list", "--json", "--vault", "deadstdio"]);
      expect(res.status).toBe(REMOTE_UNREACHABLE_EXIT);
      expect(res.stderr).toMatch(/deadstdio/);
    } finally {
      writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    }
  });
});

// ─── 3b. Registration flag validation ───────────────────────────────────────

describe("[regression] remote nests — vault add flag validation", () => {
  let configDir: string;
  let cwd: string;
  let run: ReturnType<typeof makeRunner>;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-flags-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-flags-cwd-"));
    run = makeRunner(configDir);
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("rejects --url combined with --mcp-command", () => {
    const res = run(cwd, [
      "vault", "add", "x",
      "--url", "https://a/mcp",
      "--mcp-command", "node",
    ]);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/either --url or --mcp-command/i);
  });

  it("rejects a path argument alongside --url", () => {
    const res = run(cwd, ["vault", "add", "x", "/some/path", "--url", "https://a/mcp"]);
    expect(res.status).not.toBe(0);
    expect(res.stdout + res.stderr).toMatch(/no path/i);
  });

  it("--force replaces an existing remote's endpoint", () => {
    expect(run(cwd, ["vault", "add", "x", "--url", "https://old.example.com/mcp"]).status).toBe(0);
    expect(run(cwd, ["vault", "add", "x", "--url", "https://new.example.com/mcp"]).status).not.toBe(0);
    const forced = run(cwd, ["vault", "add", "x", "--url", "https://new.example.com/mcp", "--force"]);
    expect(forced.status, forced.stderr).toBe(0);
    const registry = readFileSync(join(configDir, "config.yaml"), "utf-8");
    expect(registry).toContain("new.example.com");
    expect(registry).not.toContain("old.example.com");
  });

  it("a malformed alias is rejected for remotes too", () => {
    const res = run(cwd, ["vault", "add", "bad alias", "--url", "https://a/mcp"]);
    expect(res.status).not.toBe(0);
  });
});

// ─── 3c. Unsupported options fail loudly, not silently ──────────────────────

describe("[regression] remote nests — unsupported options fail loudly", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-unsup-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-unsup-cwd-"));
    localVault = freshVault("cn-remote-unsup-local-");
    serverVault = freshVault("cn-remote-unsup-server-");
    writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    run = makeRunner(configDir);
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx read --html on a remote errors clearly (exit 1, not 3)", () => {
    const res = run(cwd, ["read", "nodes/api-design", "--html", "--vault", "farnest"]);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/not supported/i);
  });

  it("ctx update --status on a remote errors clearly instead of diverging", () => {
    const res = run(cwd, [
      "update", "nodes/api-design", "--status", "draft", "--vault", "farnest",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/--body/);
  });

  it("ctx update with no flags on a remote reports nothing to update", () => {
    const res = run(cwd, ["update", "nodes/api-design", "--vault", "farnest"]);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/--body|nothing to update/i);
  });

  it("ctx add --type skill on a remote errors clearly", () => {
    const res = run(cwd, [
      "add", "nodes/some-skill", "--type", "skill", "--vault", "farnest",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(/not supported/i);
    expect(existsSync(join(serverVault, "nodes", "some-skill.md"))).toBe(false);
  });

  it("a remote-side failure (missing doc) exits 1 with the typed code — never 3", () => {
    const res = run(cwd, ["read", "nodes/does-not-exist", "--raw", "--vault", "farnest"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("DOCUMENT_NOT_FOUND");
  });

  it("a nonexistent stdio command exits 3 like a dead process", () => {
    const yaml = [
      "version: 1",
      "vaults: {}",
      "remotes:",
      "  ghostcmd:",
      "    transport: stdio",
      `    command: ${yq("definitely-not-a-real-command-cn")}`,
      "",
    ].join("\n");
    writeFileSync(join(configDir, "config.yaml"), yaml, "utf-8");
    try {
      const res = run(cwd, ["list", "--json", "--vault", "ghostcmd"]);
      expect(res.status).toBe(REMOTE_UNREACHABLE_EXIT);
      expect(res.stderr).toMatch(/ghostcmd/);
    } finally {
      writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    }
  });
});

// ─── 3d. Filter parity and ambient (env/default) routing ────────────────────

describe("[regression] remote nests — filter parity and ambient routing", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-amb-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-amb-cwd-"));
    localVault = freshVault("cn-remote-amb-local-");
    serverVault = freshVault("cn-remote-amb-server-");
    writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    run = makeRunner(configDir);
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx list --json --type filter is shape-identical between local and remote", () => {
    const local = run(cwd, ["list", "--json", "--type", "document", "--vault", "local"]);
    const remote = run(cwd, ["list", "--json", "--type", "document", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("ctx list --json --tag filter is shape-identical between local and remote", () => {
    const local = run(cwd, ["list", "--json", "--tag", "api", "--vault", "local"]);
    const remote = run(cwd, ["list", "--json", "--tag", "api", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
    expect(JSON.parse(remote.stdout).length).toBeGreaterThan(0);
  });

  it("ctx list --json --status alias filter is shape-identical between local and remote", () => {
    // 'active' is a status alias for 'published' — both branches must normalize it.
    const local = run(cwd, ["list", "--json", "--status", "active", "--vault", "local"]);
    const remote = run(cwd, ["list", "--json", "--status", "active", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("ctx query --hops 0 is shape-identical between local and remote", () => {
    const local = run(cwd, ["query", "#engineering", "--json", "--hops", "0", "--vault", "local"]);
    const remote = run(cwd, ["query", "#engineering", "--json", "--hops", "0", "--vault", "farnest"]);
    expect(remote.status, remote.stderr).toBe(0);
    expect(normalized(remote.stdout)).toEqual(normalized(local.stdout));
  });

  it("CONTEXTNEST_VAULT env alias routes to the remote without --vault", () => {
    const viaEnv = run(cwd, ["list", "--json"], { CONTEXTNEST_VAULT: "farnest" });
    expect(viaEnv.status, viaEnv.stderr).toBe(0);
    const viaFlag = run(cwd, ["list", "--json", "--vault", "farnest"]);
    expect(normalized(viaEnv.stdout)).toEqual(normalized(viaFlag.stdout));
  });

  it("a remote registry default routes commands from a bare cwd", () => {
    const yaml = [
      "version: 1",
      "default: farnest",
      "vaults:",
      "  local:",
      `    path: ${yq(localVault)}`,
      "remotes:",
      "  farnest:",
      "    transport: stdio",
      `    command: ${yq(process.execPath)}`,
      "    args:",
      `      - ${yq(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mcp-server", "dist", "index.js"))}`,
      `      - ${yq(serverVault)}`,
      "",
    ].join("\n");
    writeFileSync(join(configDir, "config.yaml"), yaml, "utf-8");
    try {
      const viaDefault = run(cwd, ["list", "--json"]);
      expect(viaDefault.status, viaDefault.stderr).toBe(0);
      const viaFlag = run(cwd, ["list", "--json", "--vault", "farnest"]);
      expect(normalized(viaDefault.stdout)).toEqual(normalized(viaFlag.stdout));

      // vault which reports the remote default.
      const which = run(cwd, ["vault", "which"]);
      expect(which.status, which.stderr).toBe(0);
      expect(which.stdout).toMatch(/remote/i);
      expect(which.stdout).toMatch(/farnest/);
    } finally {
      writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    }
  });

  it("ctx history on a draft with no versions reports cleanly over remote", () => {
    // nodes/onboarding-guide is a fixture draft with no .versions history.
    const res = run(cwd, ["history", "nodes/onboarding-guide", "--vault", "farnest"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/No version history/i);
  });

  it("ctx read (terminal mode) renders the remote document", () => {
    const res = run(cwd, ["read", "nodes/api-design", "--vault", "farnest"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("API Design Guidelines");
  });
});

// ─── 4. Remote routing — write surface ──────────────────────────────────────

describe("[regression] remote nests — write surface routed over stdio MCP", () => {
  let configDir: string;
  let cwd: string;
  let localVault: string;
  let serverVault: string;
  let run: ReturnType<typeof makeRunner>;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cn-remote-write-cfg-"));
    cwd = mkdtempSync(join(tmpdir(), "cn-remote-write-cwd-"));
    localVault = freshVault("cn-remote-write-local-");
    serverVault = freshVault("cn-remote-write-server-");
    writeRegistryWithStdioRemote(configDir, localVault, serverVault);
    run = makeRunner(configDir);
  });

  afterAll(() => {
    for (const dir of [configDir, cwd, localVault, serverVault]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ctx add creates the document inside the REMOTE vault, not locally", () => {
    const res = run(cwd, [
      "add",
      "nodes/remote-note",
      "--title",
      "Remote Note",
      "--body",
      "Hello from afar.",
      "--tags",
      "note",
      "--vault",
      "farnest",
    ]);
    expect(res.status, res.stderr).toBe(0);

    const remoteFile = join(serverVault, "nodes", "remote-note.md");
    expect(existsSync(remoteFile), "document missing from the remote vault").toBe(true);
    expect(readFileSync(remoteFile, "utf-8")).toContain("Hello from afar.");
    // And it must NOT have leaked into the local vault or the cwd.
    expect(existsSync(join(localVault, "nodes", "remote-note.md"))).toBe(false);
    expect(existsSync(join(cwd, "nodes", "remote-note.md"))).toBe(false);
  });

  it("ctx update edits the remote document", () => {
    const res = run(cwd, [
      "update",
      "nodes/remote-note",
      "--body",
      "Updated from afar.",
      "--vault",
      "farnest",
    ]);
    expect(res.status, res.stderr).toBe(0);
    const remoteFile = join(serverVault, "nodes", "remote-note.md");
    expect(readFileSync(remoteFile, "utf-8")).toContain("Updated from afar.");
  });

  it("ctx publish versions the remote document and history reflects it", () => {
    const publish = run(cwd, ["publish", "nodes/remote-note", "--vault", "farnest"]);
    expect(publish.status, publish.stderr).toBe(0);

    const history = run(cwd, ["history", "nodes/remote-note", "--json", "--vault", "farnest"]);
    expect(history.status, history.stderr).toBe(0);
    const json = JSON.parse(history.stdout) as { versions: unknown[] };
    expect(json.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("ctx delete removes the document from the remote vault", () => {
    const res = run(cwd, ["delete", "nodes/remote-note", "--vault", "farnest"]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(serverVault, "nodes", "remote-note.md"))).toBe(false);
  });
});
