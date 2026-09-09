/**
 * Regression test suite for the Context Nest CLI.
 *
 * Each test spawns the compiled CLI (`dist/index.js`) as a subprocess against
 * an isolated, throwaway vault — exercising the same code path a real user
 * hits. These guard the full document lifecycle (add → read → update →
 * publish → history → reconstruct → delete), query/selector surfaces, and the
 * integrity/validation gates against silent regressions.
 *
 * All describes are tagged `[regression]` so the suite can be selected with
 * `vitest run -t regression`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

// Sandbox the central vault registry so `ctx init` (which auto-registers an
// alias non-interactively) never touches the developer's / CI runner's real
// ~/.contextnest/config.yaml. Cleared up after the whole suite.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "cn-cli-reg-cfg-"));
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  CONTEXTNEST_NO_BROWSER: "1",
  CONTEXTNEST_CONFIG_DIR: CONFIG_DIR,
  // Neutralize any ambient selectors so resolution is deterministic.
  CONTEXTNEST_VAULT: "",
  CONTEXTNEST_VAULT_PATH: "",
} as NodeJS.ProcessEnv;

/** Run the CLI and return stdout. Throws on a non-zero exit. */
function runCtx(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], {
    cwd,
    env: ENV,
    encoding: "utf-8",
  });
}

const execFileAsync = promisify(execFile);

/**
 * Async CLI runner — required when the test process must stay responsive
 * while the CLI runs (e.g. servicing an in-process mock HTTP server, which a
 * blocking execFileSync would starve of the event loop). Returns stdout.
 */
async function runCtxAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("node", [distPath, ...args], {
    cwd,
    env: ENV,
    encoding: "utf-8",
  });
  return stdout;
}

/**
 * Run the CLI tolerating failure. Returns the exit status plus captured
 * stdout/stderr so error-path assertions don't have to wrap try/catch.
 */
function runCtxResult(
  cwd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  // spawnSync, not execFileSync: stderr has to come back on the SUCCESS path
  // too, since that is where the file-safety action log is written.
  const res = spawnSync("node", [distPath, ...args], {
    cwd,
    env: ENV,
    encoding: "utf-8",
  });
  return {
    status: typeof res.status === "number" ? res.status : 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function initVault(cwd: string): void {
  execFileSync(
    "node",
    [distPath, "init", "--name", "regression-vault", "--layout", "structured"],
    { cwd, env: ENV, stdio: "ignore" },
  );
}

/** Init a vault from a named starter recipe (scaffolds nodes + packs). */
function initStarter(cwd: string, recipe: string): void {
  execFileSync(
    "node",
    [distPath, "init", "--name", "starter-vault", "--starter", recipe],
    { cwd, env: ENV, stdio: "ignore" },
  );
}

interface MockServer {
  url: string;
  /** The most recently received POST body, parsed. */
  lastBody: () => unknown;
  close: () => Promise<void>;
}

/**
 * Spin up an ephemeral HTTP server that echoes a ContextNest publish response.
 * Lets `ctx push` exercise its full request/response path without a real
 * hosted engine. Listens on an OS-assigned port (0) for parallel-safe isolation.
 */
function startMockEngine(
  respond: (body: any) => Record<string, unknown>,
): Promise<MockServer> {
  return new Promise((resolve) => {
    let captured: unknown;
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        captured = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(respond(captured)));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}`,
        lastBody: () => captured,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Like runCtxAsync, but tolerates a non-zero exit — needed for the gated-push
 * paths that exit non-zero (rejected/expired) while an in-process mock server
 * must stay responsive (so spawnSync/runCtxResult, which blocks the event loop,
 * would deadlock the poll). Returns status + captured streams.
 */
async function runCtxAsyncResult(
  cwd: string,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [distPath, ...args], {
      cwd,
      env: ENV,
      encoding: "utf-8",
    });
    return { status: 0, stdout, stderr };
  } catch (e: any) {
    return { status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

interface GatedServer {
  url: string;
  /** The most recently received publish (POST) body, parsed. */
  lastBody: () => unknown;
  /** How many times the pending-push poll endpoint was hit. */
  pollCount: () => number;
  close: () => Promise<void>;
}

/**
 * A mock engine that gates the push: POST /nests/:id/publish answers 202 with a
 * pending_confirmation envelope, and GET /nests/:id/pending-pushes/:pid returns
 * the next body in `pollSequence` (repeating the last), so the CLI's confirm-gate
 * polling can be driven end to end. The first terminal poll returns immediately,
 * so tests never pay the real backoff.
 */
function startGatedEngine(pollSequence: Array<Record<string, unknown>>): Promise<GatedServer> {
  const polls = [...pollSequence];
  return new Promise((resolve) => {
    let captured: unknown;
    let gets = 0;
    const server: Server = createServer((req, res) => {
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          captured = JSON.parse(raw);
          const nest = (req.url ?? "").split("/")[2] ?? "nest-1";
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "pending_confirmation",
              pending_id: "pid1",
              confirm_url: "https://ui.example/confirm/pid1",
              poll_url: `/nests/${nest}/pending-pushes/pid1`,
              message: "This nest requires confirmation before the push is applied.",
              expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            }),
          );
        });
        return;
      }
      // GET poll
      gets++;
      const body = polls.length > 1 ? polls.shift()! : polls[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}`,
        lastBody: () => captured,
        pollCount: () => gets,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cn-regression-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── init ────────────────────────────────────────────────────────────────────

describe("[regression] ctx init", () => {
  it("scaffolds the vault config in the current directory", () => {
    const out = runCtx(tmp, [
      "init",
      "--name",
      "regression-vault",
      "--layout",
      "structured",
    ]);
    expect(out).toMatch(/Initialized structured vault/);

    const configPath = join(tmp, ".context", "config.yaml");
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("regression-vault");
  });

  it("--list-starters prints the available recipes without creating a vault", () => {
    const out = runCtx(tmp, ["init", "--list-starters"]);
    expect(out).toMatch(/Available starter recipes/);
    expect(out).toMatch(/developer/);
    expect(existsSync(join(tmp, ".context", "config.yaml"))).toBe(false);
  });
});

// ─── add ─────────────────────────────────────────────────────────────────────

describe("[regression] ctx add", () => {
  beforeEach(() => initVault(tmp));

  it("creates and auto-publishes a document at checkpoint 1", () => {
    const out = runCtx(tmp, ["add", "nodes/alpha", "--title", "Alpha Doc"]);
    expect(out).toMatch(/Created and published nodes\/alpha\.md/);
    // A brand-new document's first published version is 1. `add` used to
    // pre-set version:1 in frontmatter and let publish bump it, so the doc's
    // history started at v2 with no v1 keyframe at all. Publish owns version
    // assignment (spec §6) — the shared create path enforces that.
    expect(out).toMatch(/Version: 1/);
    expect(out).toMatch(/Checkpoint: 1/);

    const onDisk = readFileSync(join(tmp, "nodes", "alpha.md"), "utf-8");
    expect(onDisk).toMatch(/title:\s*Alpha Doc/);
    expect(onDisk).toMatch(/status:\s*published/);
  });

  it("derives a title-cased title from the path when --title is omitted", () => {
    runCtx(tmp, ["add", "nodes/schema-migration"]);
    const onDisk = readFileSync(join(tmp, "nodes", "schema-migration.md"), "utf-8");
    expect(onDisk).toMatch(/title:\s*Schema Migration/);
  });

  it("normalizes comma-separated tags with a leading #", () => {
    runCtx(tmp, ["add", "nodes/tagged", "--tags", "engineering, api"]);
    const onDisk = readFileSync(join(tmp, "nodes", "tagged.md"), "utf-8");
    expect(onDisk).toMatch(/#engineering/);
    expect(onDisk).toMatch(/#api/);
  });

  it("normalizes space-separated tags (--tags '#cmd #analyze') into discrete tags", () => {
    runCtx(tmp, ["add", "nodes/space-tags", "--tags", "#cmd #analyze"]);
    const onDisk = readFileSync(join(tmp, "nodes", "space-tags.md"), "utf-8");
    expect(onDisk).toMatch(/#cmd/);
    expect(onDisk).toMatch(/#analyze/);
    expect(onDisk).not.toMatch(/#cmd #analyze/);
  });

  it("space-separated tags on add are queryable by individual tag", () => {
    runCtx(tmp, ["add", "nodes/queryable-tags", "--tags", "#alpha #beta"]);
    const matched = JSON.parse(runCtx(tmp, ["resolve", "#alpha", "--json"])).map(
      (d: { id: string }) => d.id,
    );
    expect(matched).toContain("nodes/queryable-tags");
  });

  it("scaffolds a skill block for --type skill", () => {
    runCtx(tmp, [
      "add",
      "nodes/deploy-skill",
      "--type",
      "skill",
      "--trigger",
      "when asked to deploy",
    ]);
    const onDisk = readFileSync(join(tmp, "nodes", "deploy-skill.md"), "utf-8");
    expect(onDisk).toMatch(/type:\s*skill/);
    expect(onDisk).toMatch(/trigger:\s*when asked to deploy/);
  });

  it("stores a bare slug under nodes/ instead of the vault root", () => {
    const out = runCtx(tmp, ["add", "qaish", "--title", "Qaish"]);
    expect(out).toMatch(/Created and published nodes\/qaish\.md/);
    // The file lands in nodes/, not at the vault root.
    expect(existsSync(join(tmp, "nodes", "qaish.md"))).toBe(true);
    expect(existsSync(join(tmp, "qaish.md"))).toBe(false);
  });
});

// ─── read ────────────────────────────────────────────────────────────────────

describe("[regression] ctx read", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/readme", "--title", "Read Me", "--body", "Hello body"]);
  });

  it("renders title, metadata, and body in the terminal view", () => {
    const out = runCtx(tmp, ["read", "nodes/readme"]);
    expect(out).toMatch(/Read Me/);
    expect(out).toMatch(/Hello body/);
    expect(out).toMatch(/published/);
  });

  it("--raw emits the verbatim file content including frontmatter", () => {
    const out = runCtx(tmp, ["read", "nodes/readme", "--raw"]);
    expect(out).toMatch(/^---/);
    expect(out).toMatch(/title:\s*Read Me/);
  });

  it("accepts a path with a trailing .md extension", () => {
    const out = runCtx(tmp, ["read", "nodes/readme.md", "--raw"]);
    expect(out).toMatch(/title:\s*Read Me/);
  });

  it("reads and publishes a doc back by the same bare slug it was created with", () => {
    // Regression: `add` normalizes a bare slug into nodes/, so every other
    // command must normalize identically or the doc is unreachable by slug.
    runCtx(tmp, ["add", "qaish", "--title", "Qaish", "--body", "Bare slug body"]);
    // read by bare slug resolves (would throw DOCUMENT_NOT_FOUND pre-fix).
    const out = runCtx(tmp, ["read", "qaish"]);
    expect(out).toMatch(/Qaish/);
    expect(out).toMatch(/Bare slug body/);
    // publish by bare slug resolves too (does not error out).
    expect(() => runCtx(tmp, ["publish", "qaish"])).not.toThrow();
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe("[regression] ctx list", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/doc-a", "--title", "Doc A", "--tags", "alpha"]);
    runCtx(tmp, ["add", "nodes/skill-b", "--title", "Skill B", "--type", "skill"]);
  });

  it("--json lists all non-rejected documents", () => {
    const parsed = JSON.parse(runCtx(tmp, ["list", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/doc-a");
    expect(ids).toContain("nodes/skill-b");
  });

  it("--type filters by node type", () => {
    const parsed = JSON.parse(runCtx(tmp, ["list", "--type", "skill", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toEqual(["nodes/skill-b"]);
  });

  it("--tag filters by tag (with or without the # prefix)", () => {
    const parsed = JSON.parse(runCtx(tmp, ["list", "--tag", "alpha", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toEqual(["nodes/doc-a"]);
  });
});

// ─── query ───────────────────────────────────────────────────────────────────

describe("[regression] ctx query", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/q-doc", "--title", "Query Doc"]);
  });

  it("--json returns a graph-mode result envelope", () => {
    const parsed = JSON.parse(runCtx(tmp, ["query", "type:document", "--json"]));
    expect(parsed.mode).toBe("graph");
    expect(Array.isArray(parsed.documents)).toBe(true);
    const ids = parsed.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/q-doc");
    expect(typeof parsed.hopsUsed).toBe("number");
    expect(typeof parsed.nodesTraversed).toBe("number");
  });
});

// ─── resolve ─────────────────────────────────────────────────────────────────

describe("[regression] ctx resolve", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/r-doc", "--title", "Resolve Doc"]);
  });

  it("--json returns the matched documents for a selector", () => {
    const parsed = JSON.parse(runCtx(tmp, ["resolve", "type:document", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/r-doc");
    const match = parsed.find((d: { id: string }) => d.id === "nodes/r-doc");
    expect(match.status).toBe("published");
  });

  it("reports no matches for a selector that hits nothing", () => {
    const out = runCtx(tmp, ["resolve", "#nonexistent-tag"]);
    expect(out).toMatch(/No documents matched/);
  });
});

// ─── search ──────────────────────────────────────────────────────────────────

describe("[regression] ctx search", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/searchable", "--title", "Findable Title"]);
  });

  it("--json returns full-text matches", () => {
    const parsed = JSON.parse(runCtx(tmp, ["search", "Findable", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/searchable");
  });

  it("finds a bare-slug node now that add stores it under nodes/", () => {
    runCtx(tmp, ["add", "qaish", "--title", "Qaish Bareslug"]);
    const parsed = JSON.parse(runCtx(tmp, ["search", "Bareslug", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/qaish");
  });

  it("finds a root-level file added without `ctx add` (live discovery)", () => {
    // A file dropped at the vault root by hand — no `ctx add`, no re-index.
    writeFileSync(
      join(tmp, "stray.md"),
      [
        "---",
        "title: Stray Root Doc",
        "type: document",
        "status: published",
        "version: 1",
        "---",
        "",
        "# Stray Root Doc",
        "",
        "Findable even at the root.",
        "",
      ].join("\n"),
    );
    const parsed = JSON.parse(runCtx(tmp, ["search", "Stray", "--json"]));
    const ids = parsed.map((d: { id: string }) => d.id);
    expect(ids).toContain("stray");
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe("[regression] ctx update", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/mutable", "--title", "Original"]);
  });

  it("a content edit auto-publishes and bumps the version", () => {
    const out = runCtx(tmp, ["update", "nodes/mutable", "--body", "Revised body"]);
    expect(out).toMatch(/Updated and published nodes\/mutable/);
    // add landed at v1; a content update cuts v2.
    expect(out).toMatch(/Version: 2/);

    const onDisk = readFileSync(join(tmp, "nodes", "mutable.md"), "utf-8");
    expect(onDisk).toMatch(/Revised body/);
  });

  it("a title change is persisted to the frontmatter", () => {
    runCtx(tmp, ["update", "nodes/mutable", "--title", "Renamed"]);
    const onDisk = readFileSync(join(tmp, "nodes", "mutable.md"), "utf-8");
    expect(onDisk).toMatch(/title:\s*Renamed/);
  });

  it("a lifecycle-only status change does not cut a new version", () => {
    const out = runCtx(tmp, ["update", "nodes/mutable", "--status", "draft"]);
    expect(out).toMatch(/No new version cut/);
    const onDisk = readFileSync(join(tmp, "nodes", "mutable.md"), "utf-8");
    expect(onDisk).toMatch(/status:\s*draft/);
  });

  it("normalizes space-separated tags on update into discrete queryable tags", () => {
    runCtx(tmp, ["update", "nodes/mutable", "--tags", "#foo #bar"]);
    const onDisk = readFileSync(join(tmp, "nodes", "mutable.md"), "utf-8");
    expect(onDisk).toMatch(/#foo/);
    expect(onDisk).toMatch(/#bar/);
    expect(onDisk).not.toMatch(/#foo #bar/);

    const matched = JSON.parse(runCtx(tmp, ["resolve", "#foo", "--json"])).map(
      (d: { id: string }) => d.id,
    );
    expect(matched).toContain("nodes/mutable");
  });
});

// ─── publish / history / reconstruct ──────────────────────────────────────────

describe("[regression] ctx publish, history & reconstruct", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/release", "--title", "Release Doc"]);
  });

  it("publish bumps the version, advances the checkpoint, and reports a chain hash", () => {
    const out = runCtx(tmp, ["publish", "nodes/release", "-m", "second cut"]);
    expect(out).toMatch(/Published nodes\/release/);
    expect(out).toMatch(/Version: 2/);
    expect(out).toMatch(/Chain hash: sha256:/);
  });

  it("history --json records published versions with chain hashes", () => {
    runCtx(tmp, ["publish", "nodes/release", "-m", "cut"]);
    const history = JSON.parse(runCtx(tmp, ["history", "nodes/release", "--json"]));
    const versions = history.versions.map((v: { version: number }) => v.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
    for (const v of history.versions) {
      expect(v.chain_hash).toMatch(/^sha256:/);
    }
  });

  it("reconstruct returns the serialized content for a known version", () => {
    // beforeEach leaves the doc at v1, so v2 has to be cut here. This asked for
    // v2 without publishing and passed anyway: reconstruct fell back to the
    // nearest keyframe and handed back v1, which carries the same title.
    runCtx(tmp, ["publish", "nodes/release", "-m", "cut"]);
    const content = runCtx(tmp, ["reconstruct", "nodes/release", "2"]);
    expect(content).toMatch(/title:\s*Release Doc/);
    // Assert the VERSION, not just the title — that is what tells v2 from v1.
    expect(content).toMatch(/version:\s*2/);
  });

  /** Highest checkpoint number currently sealed in the vault. */
  const latestCheckpoint = (): number =>
    JSON.parse(runCtx(tmp, ["checkpoint", "list", "--json", "-n", "1"]))[0].checkpoint;

  it("publish --all publishes every draft in one batch, under ONE checkpoint", () => {
    // Drafts written straight to disk, as a folder import leaves them —
    // `ctx add` publishes on create, so it cannot produce this state.
    for (const slug of ["draft-a", "draft-b", "draft-c"]) {
      writeFileSync(
        join(tmp, "nodes", `${slug}.md`),
        `---\ntitle: ${slug}\ntype: document\nstatus: draft\nversion: 1\n---\n\nbody\n`,
      );
    }
    const before = latestCheckpoint();

    const out = runCtx(tmp, ["publish", "--all"]);
    expect(out).toMatch(/Published 3 document\(s\)/);

    // One checkpoint for the whole batch — a publish-per-doc loop adds three.
    expect(latestCheckpoint() - before).toBe(1);
    expect(runCtx(tmp, ["read", "nodes/draft-b"])).toMatch(/status:\s*published/);
  });

  it("publish --all is a no-op when nothing is unpublished", () => {
    expect(runCtx(tmp, ["publish", "--all"])).toMatch(/Nothing to publish/);
  });

  it("publish rejects a path and --all together", () => {
    const { status, stderr } = runCtxResult(tmp, ["publish", "nodes/release", "--all"]);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Pass a path or --all, not both/);
  });
});

// ─── delete ──────────────────────────────────────────────────────────────────

describe("[regression] ctx delete", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/disposable", "--title", "Disposable"]);
  });

  it("removes the document and its version history", () => {
    expect(existsSync(join(tmp, "nodes", "disposable.md"))).toBe(true);

    const out = runCtx(tmp, ["delete", "nodes/disposable", "--yes"]);
    expect(out).toMatch(/Deleted nodes\/disposable/);

    expect(existsSync(join(tmp, "nodes", "disposable.md"))).toBe(false);
    expect(existsSync(join(tmp, "nodes", ".versions", "disposable"))).toBe(false);
  });
});

// ─── verify (integrity) ───────────────────────────────────────────────────────

describe("[regression] ctx verify", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/sealed", "--title", "Sealed"]);
  });

  it("passes on an untampered vault and exits 0", () => {
    const res = runCtxResult(tmp, ["verify"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/All integrity checks passed/);
  });

  it("detects a tampered keyframe and exits non-zero", () => {
    appendFileSync(
      join(tmp, "nodes", ".versions", "sealed", "v1.md"),
      "\ntampered content\n",
    );
    const res = runCtxResult(tmp, ["verify"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/content_hash_mismatch/);
    expect(res.stdout).toMatch(/integrity error/);
  });
});

// ─── validate ─────────────────────────────────────────────────────────────────

describe("[regression] ctx validate", () => {
  beforeEach(() => initVault(tmp));

  it("passes a well-formed document", () => {
    runCtx(tmp, ["add", "nodes/clean", "--title", "Clean Doc"]);
    const res = runCtxResult(tmp, ["validate", "nodes/clean"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/✓ nodes\/clean/);
  });

  it("flags a document missing a required field and exits non-zero", () => {
    writeFileSync(
      join(tmp, "nodes", "broken.md"),
      "---\ntype: document\n---\n\nNo title here.\n",
      "utf-8",
    );
    const res = runCtxResult(tmp, ["validate", "nodes/broken", "--json"]);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors[0].errors[0].field).toBe("title");
  });
});

// ─── index ────────────────────────────────────────────────────────────────────

describe("[regression] ctx index", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/indexed", "--title", "Indexed"]);
  });

  it("regenerates context.yaml and a per-folder INDEX.md", () => {
    const out = runCtx(tmp, ["index"]);
    expect(out).toMatch(/Generated context\.yaml/);
    expect(existsSync(join(tmp, "context.yaml"))).toBe(true);
    expect(existsSync(join(tmp, "nodes", "INDEX.md"))).toBe(true);
  });

  // Parity with MCP read_index: assert the *content* of the generated index,
  // not just file existence. Catches regressions where index gen silently
  // drops published docs.
  it("context.yaml lists the published document id", () => {
    runCtx(tmp, ["index"]);
    const yaml = readFileSync(join(tmp, "context.yaml"), "utf-8");
    expect(yaml).toContain("nodes/indexed");
  });
});

// ─── checkpoint ───────────────────────────────────────────────────────────────

describe("[regression] ctx checkpoint", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/cp-doc", "--title", "Checkpoint Doc"]);
  });

  it("list --json reports checkpoint metadata and hashes", () => {
    const parsed = JSON.parse(runCtx(tmp, ["checkpoint", "list", "--json"]));
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    const first = parsed[0];
    expect(first.checkpoint).toBe(1);
    expect(first.checkpoint_hash).toMatch(/^sha256:/);
    expect(first.document_versions["nodes/cp-doc"]).toBeDefined();
  });

  it("rebuild reconstructs checkpoint history from per-document histories", () => {
    const out = runCtx(tmp, ["checkpoint", "rebuild", "--yes"]);
    expect(out).toMatch(/Rebuilt \d+ checkpoints/);
  });

  // Parity with MCP list_checkpoints "honors limit": every published mutation
  // cuts a checkpoint, so several adds give us enough history to slice. The
  // --limit (alias -n) flag must clamp the returned list.
  it("list --limit clamps the number of returned checkpoints", () => {
    runCtx(tmp, ["add", "nodes/cp-extra-1", "--title", "Extra 1"]);
    runCtx(tmp, ["add", "nodes/cp-extra-2", "--title", "Extra 2"]);
    const all = JSON.parse(runCtx(tmp, ["checkpoint", "list", "--json"]));
    expect(all.length).toBeGreaterThanOrEqual(3);

    const limited = JSON.parse(runCtx(tmp, ["checkpoint", "list", "--json", "--limit", "2"]));
    expect(limited).toHaveLength(2);
    // slice(-limit) returns the trailing checkpoints — assert ordering matches.
    expect(limited[limited.length - 1].checkpoint).toBe(all[all.length - 1].checkpoint);
  });
});

// ─── error handling ───────────────────────────────────────────────────────────

describe("[regression] error handling", () => {
  beforeEach(() => initVault(tmp));

  it("reading a non-existent document exits non-zero", () => {
    const res = runCtxResult(tmp, ["read", "nodes/does-not-exist"]);
    expect(res.status).not.toBe(0);
  });

  it("--version matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf-8"),
    ) as { version: string };
    const out = runCtx(tmp, ["--version"]).trim();
    expect(out).toBe(pkg.version);
  });
});

// ─── selector operators ─────────────────────────────────────────────────────
// The atomic resolve/query tests above only exercise single-term selectors.
// These pin the composition operators (+ AND, | OR, - NOT) the query value
// proposition depends on, which were previously untested through the CLI.

describe("[regression] selector operators", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/auth", "--title", "Auth", "--tags", "security,api"]);
    runCtx(tmp, ["add", "nodes/billing", "--title", "Billing", "--tags", "payments"]);
  });

  const ids = (json: string): string[] =>
    JSON.parse(json).map((d: { id: string }) => d.id);

  it("| (OR) returns the union of both terms", () => {
    const matched = ids(runCtx(tmp, ["resolve", "#security | #payments", "--json"]));
    expect(matched).toContain("nodes/auth");
    expect(matched).toContain("nodes/billing");
  });

  it("- (NOT) excludes the negated term", () => {
    const matched = ids(runCtx(tmp, ["resolve", "type:document - #payments", "--json"]));
    expect(matched).toContain("nodes/auth");
    expect(matched).not.toContain("nodes/billing");
  });

  it("+ (AND) requires both terms", () => {
    const matched = ids(runCtx(tmp, ["resolve", "type:document + #security", "--json"]));
    expect(matched).toEqual(["nodes/auth"]);
  });

  // Regression: a `-` inside a URI path must not split the URI into URI + NOT
  // word. Pairs with the engine-level lexer test for the same fix.
  it("resolves a hyphenated URI selector end-to-end", () => {
    runCtx(tmp, ["add", "nodes/api-design", "--title", "API Design"]);
    const matched = ids(runCtx(tmp, ["resolve", "contextnest://nodes/api-design", "--json"]));
    expect(matched).toEqual(["nodes/api-design"]);
  });
});

// ─── query --full mode ──────────────────────────────────────────────────────

describe("[regression] ctx query --full", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/q-full", "--title", "Full Doc"]);
  });

  it("--full forces full-load mode in the result envelope", () => {
    const parsed = JSON.parse(runCtx(tmp, ["query", "type:document", "--full", "--json"]));
    expect(parsed.mode).toBe("full");
    const matched = parsed.documents.map((d: { id: string }) => d.id);
    expect(matched).toContain("nodes/q-full");
  });
});

// ─── query --include-drafts ─────────────────────────────────────────────────

describe("[regression] ctx query --include-drafts", () => {
  beforeEach(() => {
    initVault(tmp);
    // Published baseline.
    runCtx(tmp, ["add", "nodes/q-pub", "--title", "Published Doc"]);
    // Plant a raw draft on disk — bypasses the auto-publish that `ctx add` does.
    writeFileSync(
      join(tmp, "nodes", "q-draft.md"),
      `---\ntitle: "Draft Doc"\nstatus: draft\n---\n\nbody\n`,
      "utf-8",
    );
    runCtx(tmp, ["index"]);
  });

  it("hides drafts by default", () => {
    const parsed = JSON.parse(runCtx(tmp, ["query", "type:document", "--json"]));
    const ids = parsed.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/q-pub");
    expect(ids).not.toContain("nodes/q-draft");
  });

  it("--include-drafts surfaces draft documents alongside published", () => {
    const parsed = JSON.parse(
      runCtx(tmp, ["query", "type:document", "--include-drafts", "--json"]),
    );
    const ids = parsed.documents.map((d: { id: string }) => d.id);
    expect(ids).toContain("nodes/q-pub");
    expect(ids).toContain("nodes/q-draft");
  });
});

// ─── list --status filter ───────────────────────────────────────────────────

describe("[regression] ctx list --status", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/keep", "--title", "Keep"]);
    runCtx(tmp, ["add", "nodes/retired", "--title", "Retired"]);
    runCtx(tmp, ["update", "nodes/retired", "--status", "rejected"]);
  });

  const ids = (json: string): string[] =>
    JSON.parse(json).map((d: { id: string }) => d.id);

  it("hides rejected documents by default", () => {
    const matched = ids(runCtx(tmp, ["list", "--json"]));
    expect(matched).toContain("nodes/keep");
    expect(matched).not.toContain("nodes/retired");
  });

  it("--status rejected surfaces only the retired document", () => {
    const matched = ids(runCtx(tmp, ["list", "--status", "rejected", "--json"]));
    expect(matched).toContain("nodes/retired");
    expect(matched).not.toContain("nodes/keep");
  });
});

// ─── validate --json (valid path) ───────────────────────────────────────────

describe("[regression] ctx validate --json (valid)", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/ok", "--title", "OK"]);
  });

  it("reports valid:true with no errors for a clean vault", () => {
    const res = runCtxResult(tmp, ["validate", "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
  });
});

// ─── pack operations ────────────────────────────────────────────────────────
// Packs are scaffolded by starter recipes, so this also covers that a starter
// init actually produces nodes + packs (previously only --list-starters was
// asserted).

describe("[regression] ctx pack", () => {
  beforeEach(() => initStarter(tmp, "developer"));

  // Every starter node shipped `type: context`, which is not in NODE_TYPES.
  // `init --starter` writes and publishes without validating, so the vault
  // looked fine until the user ran `ctx update` or `ctx validate` on a
  // scaffolded document. Nothing scaffolded may be born spec-invalid.
  it("init --starter produces a vault that validates clean", () => {
    const res = runCtxResult(tmp, ["validate", "--json"]);
    const report = JSON.parse(res.stdout);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(res.status).toBe(0);
  });

  it("a scaffolded document can be updated without a validation error", () => {
    const out = runCtx(tmp, [
      "update",
      "nodes/architecture/architecture-overview",
      "--tags",
      "architecture, overview",
      "--yes",
    ]);
    expect(out).toMatch(/Updated and published/);
  });

  it("init --starter scaffolds documents and at least one pack", () => {
    const docs = JSON.parse(runCtx(tmp, ["list", "--json"]));
    expect(docs.length).toBeGreaterThan(0);
    const packs = JSON.parse(runCtx(tmp, ["pack", "list", "--json"]));
    expect(packs.length).toBeGreaterThanOrEqual(1);
    expect(packs[0].id).toBeTruthy();
    expect(packs[0].label).toBeTruthy();
  });

  it("show renders a known pack's details", () => {
    const packs = JSON.parse(runCtx(tmp, ["pack", "list", "--json"]));
    const out = runCtx(tmp, ["pack", "show", packs[0].id]);
    expect(out).toContain(packs[0].label);
  });

  it("show exits non-zero for an unknown pack", () => {
    const res = runCtxResult(tmp, ["pack", "show", "no.such.pack"]);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toMatch(/not found/);
  });
});

// ─── html rendering ─────────────────────────────────────────────────────────

describe("[regression] html rendering", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/page", "--title", "Page", "--body", "Hello world"]);
  });

  it("read --html --out writes a standalone HTML file", () => {
    const out = join(tmp, "page.html");
    const res = runCtx(tmp, ["read", "nodes/page", "--html", "--out", out]);
    expect(res).toMatch(/Written to/);
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, "utf-8");
    expect(html).toMatch(/<!DOCTYPE html>/);
    expect(html).toContain("Page");
  });

  it("welcome --no-open regenerates .context/welcome.html without opening a browser", () => {
    const res = runCtx(tmp, ["welcome", "--no-open"]);
    expect(res).toMatch(/Generated welcome page/);
    expect(existsSync(join(tmp, ".context", "welcome.html"))).toBe(true);
  });
});

// ─── push ───────────────────────────────────────────────────────────────────
// Exercises the full publish request against an ephemeral mock engine — the
// command was previously untested anywhere.

describe("[regression] ctx push", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/pushable", "--title", "Pushable", "--tags", "engineering"]);
  });

  it("posts published documents and reports the server's count", async () => {
    const server = await startMockEngine((body) => ({
      published: body.documents.length,
      context_md_updated: Boolean(body.context_md),
      node_ids: body.documents.map((_: unknown, i: number) => `node-${i}`),
    }));
    try {
      const out = await runCtxAsync(tmp, [
        "push",
        "--server", server.url,
        "--nest", "nest-1",
        "--key", "cnst_testkey",
        "--yes",
      ]);
      expect(out).toMatch(/Pushed 1 document/);

      const body = server.lastBody() as { documents: Array<{ title: string; tags: string[] }> };
      expect(body.documents).toHaveLength(1);
      expect(body.documents[0].title).toBe("Pushable");
      expect(body.documents[0].tags).toContain("#engineering");
    } finally {
      await server.close();
    }
  });

  it("exits non-zero when a required connection option is missing", () => {
    const res = runCtxResult(tmp, ["push", "--nest", "n", "--key", "k"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--server/);
  });

  it("reports a clean no-op when there is nothing to push", () => {
    // A fresh vault with the seed config doc only — no published nodes — and
    // drafts excluded by default should short-circuit before any network call.
    const empty = mkdtempSync(join(tmpdir(), "cn-push-empty-"));
    try {
      initVault(empty);
      const res = runCtxResult(empty, [
        "push",
        "--server", "http://127.0.0.1:1",
        "--nest", "nest-1",
        "--key", "cnst_testkey",
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/No documents to push/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // ─── confirmation gate (202) ────────────────────────────────────────────────
  // A gated nest parks the push for a human to confirm and answers 202 instead
  // of applying. The CLI must recognize that, surface the confirm URL, and (by
  // default) poll to the decision — never misreport the pending 202 as applied.

  it("a gated push (202) polls to 'applied' and reports the confirmed count (exit 0)", async () => {
    const server = await startGatedEngine([{ status: "applied", applied_node_count: 1, decided_by: "steward@ex" }]);
    try {
      const res = await runCtxAsyncResult(tmp, [
        "push",
        "--server", server.url,
        "--nest", "nest-1",
        "--key", "cnst_testkey",
        "--yes",
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Confirm in the UI: https:\/\/ui\.example\/confirm\/pid1/);
      expect(res.stdout).toMatch(/Pushed 1 document/);
      expect(server.pollCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it("a gated push that is rejected exits non-zero and says nothing was applied", async () => {
    const server = await startGatedEngine([{ status: "rejected", decided_by: "steward@ex" }]);
    try {
      const res = await runCtxAsyncResult(tmp, [
        "push",
        "--server", server.url,
        "--nest", "nest-1",
        "--key", "cnst_testkey",
        "--yes",
      ]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/rejected/i);
      expect(res.stdout).not.toMatch(/Pushed/);
    } finally {
      await server.close();
    }
  });

  it("--no-wait submits, prints the confirm URL, and exits 0 without polling", async () => {
    const server = await startGatedEngine([{ status: "pending" }]);
    try {
      const res = await runCtxAsyncResult(tmp, [
        "push",
        "--server", server.url,
        "--nest", "nest-1",
        "--key", "cnst_testkey",
        "--yes",
        "--no-wait",
      ]);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Confirm in the UI: https:\/\/ui\.example\/confirm\/pid1/);
      expect(res.stdout).not.toMatch(/Pushed/);
      expect(server.pollCount()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

// ─── end-to-end flows ───────────────────────────────────────────────────────
// Unlike the atomic command tests above, each test here runs a complete
// user journey on a SINGLE document and asserts state at every step — the
// flow-level coverage the suite previously lacked.

describe("[regression] flows", () => {
  beforeEach(() => initVault(tmp));

  it("full document lifecycle: add → read → update → history → reconstruct → delete", () => {
    // add (auto-publishes the new doc at v1)
    const added = runCtx(tmp, ["add", "nodes/lc", "--title", "Lifecycle", "--body", "first body"]);
    expect(added).toMatch(/Version: 1/);

    // read shows the current body
    expect(runCtx(tmp, ["read", "nodes/lc"])).toContain("first body");

    // a content edit auto-publishes a new version
    const updated = runCtx(tmp, ["update", "nodes/lc", "--body", "second body"]);
    expect(updated).toMatch(/Version: 2/);

    // history records both published versions with chain hashes
    const history = JSON.parse(runCtx(tmp, ["history", "nodes/lc", "--json"]));
    const versions = history.versions.map((v: { version: number }) => v.version);
    expect(versions).toEqual(expect.arrayContaining([1, 2]));

    // each version reconstructs to the body it was published with
    expect(runCtx(tmp, ["reconstruct", "nodes/lc", "1"])).toContain("first body");
    expect(runCtx(tmp, ["reconstruct", "nodes/lc", "2"])).toContain("second body");

    // delete removes the doc and its version history; reads then fail
    runCtx(tmp, ["delete", "nodes/lc", "--yes"]);
    expect(existsSync(join(tmp, "nodes", "lc.md"))).toBe(false);
    expect(existsSync(join(tmp, "nodes", ".versions", "lc"))).toBe(false);
    expect(runCtxResult(tmp, ["read", "nodes/lc"]).status).not.toBe(0);
  });

  it("deprecation hygiene: retiring a doc hides it from listings and queries but keeps it auditable", () => {
    runCtx(tmp, ["add", "nodes/soap", "--title", "SOAP Bridge", "--tags", "engineering,legacy", "--body", "deprecated"]);
    runCtx(tmp, ["add", "nodes/rest", "--title", "REST API", "--tags", "engineering"]);

    // retire the legacy doc (status change is metadata-only)
    runCtx(tmp, ["update", "nodes/soap", "--status", "rejected"]);

    const listed = JSON.parse(runCtx(tmp, ["list", "--json"])).map((d: { id: string }) => d.id);
    expect(listed).toContain("nodes/rest");
    expect(listed).not.toContain("nodes/soap");

    // it remains auditable via an explicit status filter
    const retired = JSON.parse(runCtx(tmp, ["list", "--status", "rejected", "--json"])).map((d: { id: string }) => d.id);
    expect(retired).toContain("nodes/soap");

    // an agent query for the live engineering docs excludes the retired one
    const queried = JSON.parse(runCtx(tmp, ["resolve", "#engineering", "--json"])).map((d: { id: string }) => d.id);
    expect(queried).toContain("nodes/rest");
    expect(queried).not.toContain("nodes/soap");

    // and the hash chain is still intact
    expect(runCtxResult(tmp, ["verify"]).status).toBe(0);
  });

  it("drift governance (approve): out-of-band edit → scan → stage → list → approve → clean", () => {
    runCtx(tmp, ["add", "nodes/policy", "--title", "Policy", "--body", "original"]);

    // simulate an out-of-band edit by mutating the file bytes directly
    appendFileSync(join(tmp, "nodes", "policy.md"), "\n\nout-of-band edit\n");

    // scan detects the drift and exits non-zero
    const scan = runCtxResult(tmp, ["drift", "scan", "--json"]);
    expect(scan.status).toBe(1);
    expect(JSON.parse(scan.stdout).drifted).toHaveLength(1);

    // stage it as a reviewable suggestion
    const staged = JSON.parse(runCtx(tmp, ["drift", "stage", "nodes/policy", "--json"]));
    const sid: string = staged.suggestion_id;
    expect(sid).toBeTruthy();

    // it shows up as a pending suggestion
    expect(JSON.parse(runCtx(tmp, ["drift", "list", "nodes/policy", "--json"])).count).toBe(1);

    // approving merges the edit and bumps the version
    const approved = JSON.parse(runCtx(tmp, ["drift", "approve", "nodes/policy", sid, "--json", "--yes"]));
    expect(approved.versionEntry.version).toBe(2);

    // the suggestion is archived and the vault is clean again
    expect(JSON.parse(runCtx(tmp, ["drift", "list", "nodes/policy", "--json"])).count).toBe(0);
    const rescan = runCtxResult(tmp, ["drift", "scan"]);
    expect(rescan.status).toBe(0);
    expect(rescan.stdout).toMatch(/No drift detected/);
    expect(runCtxResult(tmp, ["verify"]).status).toBe(0);
  });

  it("drift governance (reject): a rejected suggestion is archived without bumping the version", () => {
    runCtx(tmp, ["add", "nodes/policy2", "--title", "Policy Two", "--body", "original"]);
    appendFileSync(join(tmp, "nodes", "policy2.md"), "\n\nunauthorized edit\n");

    const staged = JSON.parse(runCtx(tmp, ["drift", "stage", "nodes/policy2", "--json"]));
    const sid: string = staged.suggestion_id;

    runCtx(tmp, ["drift", "reject", "nodes/policy2", sid, "--reason", "not approved", "--json"]);

    // no longer staged…
    expect(JSON.parse(runCtx(tmp, ["drift", "list", "nodes/policy2", "--json"])).count).toBe(0);

    // …and the canonical version was NOT advanced (rejection doesn't merge)
    const versions = JSON.parse(runCtx(tmp, ["history", "nodes/policy2", "--json"]))
      .versions.map((v: { version: number }) => v.version);
    expect(versions).not.toContain(3);
  });
});

// ─── add / update edge cases ────────────────────────────────────────────────
// Parity with the MCP create_document / update_document edge-case coverage:
// duplicate guard, rejected-doc edit guard, unknown-status fallback, and
// status-alias normalization on disk.

describe("[regression] add/update edge cases", () => {
  beforeEach(() => initVault(tmp));

  it("add over an existing path fails instead of silently succeeding", () => {
    runCtx(tmp, ["add", "nodes/dup", "--title", "Original"]);
    const res = runCtxResult(tmp, ["add", "nodes/dup", "--title", "Replacement"]);
    expect(res.status).not.toBe(0);
    // NOTE — divergence from MCP create_document: the CLI rewrites the file
    // template before the publish-time guard fires, so the original bytes are
    // NOT preserved. We assert only the non-zero exit, to lock the contract
    // without cementing that side-effect wart.
  });

  it("update refuses to publish a content edit on a rejected document", () => {
    runCtx(tmp, ["add", "nodes/rej", "--title", "Rejected", "--body", "original"]);
    runCtx(tmp, ["update", "nodes/rej", "--status", "rejected"]);

    const res = runCtxResult(tmp, ["update", "nodes/rej", "--body", "sneaky edit"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Error \[REJECTED_DOCUMENT\]/);
    // No raw stack trace leaks to end users.
    expect(res.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("publish on a rejected document fails with a friendly error, no stack trace", () => {
    runCtx(tmp, ["add", "nodes/rej2", "--title", "Rejected Two", "--body", "x"]);
    runCtx(tmp, ["update", "nodes/rej2", "--status", "rejected"]);

    const res = runCtxResult(tmp, ["publish", "nodes/rej2"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Error \[REJECTED_DOCUMENT\]/);
    expect(res.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("an invalid selector fails with a friendly error, no stack trace", () => {
    const res = runCtxResult(tmp, ["resolve", "tag:"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Error \[INVALID_SELECTOR\]: Invalid tag filter/);
    expect(res.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("reconstruct names the missing document, not a missing version, no stack trace", () => {
    // Asking for v1 of a document that does not exist is a missing DOCUMENT.
    // Saying VERSION_NOT_FOUND sends the reader hunting through a history that
    // was never going to be there either.
    const res = runCtxResult(tmp, ["reconstruct", "nodes/never-existed", "1"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Error \[DOCUMENT_NOT_FOUND\]/);
    expect(res.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("reconstruct reports a missing VERSION of a document that does exist", () => {
    runCtx(tmp, ["add", "nodes/only-v1", "--title", "Only V1"]);
    const res = runCtxResult(tmp, ["reconstruct", "nodes/only-v1", "99"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Error \[VERSION_NOT_FOUND\]/);
    expect(res.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("update falls back to draft for an unknown status", () => {
    runCtx(tmp, ["add", "nodes/unk", "--title", "Unknown"]);
    runCtx(tmp, ["update", "nodes/unk", "--status", "not-a-real-status"]);
    expect(readFileSync(join(tmp, "nodes", "unk.md"), "utf-8")).toMatch(/status:\s*draft/);
  });

  it("update normalizes a status alias on disk (active → published)", () => {
    runCtx(tmp, ["add", "nodes/alias", "--title", "Aliased"]);
    runCtx(tmp, ["update", "nodes/alias", "--status", "active"]);
    expect(readFileSync(join(tmp, "nodes", "alias.md"), "utf-8")).toMatch(/status:\s*published/);
  });
});

// ─── keyframe tamper detection (cross-surface contract) ──────────────────────
// Mirrors the engine verifyVaultIntegrity and MCP verify_integrity keyframe
// tests. `ctx verify` has always caught this (it re-hashes keyframes); these
// three suites now encode the same guarantee on every surface.

describe("[regression] integrity — keyframe tamper", () => {
  beforeEach(() => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/archived", "--title", "Archived", "--body", "trusted history"]);
  });

  it("ctx verify reports content_hash_mismatch when a version keyframe is tampered", () => {
    // Canonical .md and history.yaml are untouched — only a keyframe re-hash
    // can surface this corruption.
    appendFileSync(join(tmp, "nodes", ".versions", "archived", "v1.md"), "\nrewritten history\n");
    const res = runCtxResult(tmp, ["verify", "--json"]);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.map((e: { type: string }) => e.type)).toContain("content_hash_mismatch");
  });
});

// ─── file safety ─────────────────────────────────────────────────────────────
// Q2 hardening: no ctx subcommand may touch the working directory without the
// user seeing it coming (confirmation or an explicit flag), being able to
// preview it (--dry-run), and being told exactly what happened (action log).

describe("[regression] file safety", () => {
  beforeEach(() => {
    initVault(tmp);
  });

  it("prints an action log naming every file a write command touched", () => {
    const res = runCtxResult(tmp, ["add", "nodes/logged", "--title", "Logged"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/file\(s\) changed:/);
    expect(res.stderr).toContain("nodes/logged.md");
    expect(res.stderr).toContain("nodes/.versions/logged/v1.md");
    expect(res.stderr).toContain("context.yaml");
  });

  it("keeps the action log off stdout so --json output stays parseable", () => {
    runCtx(tmp, ["add", "nodes/machine", "--title", "Machine"]);
    const stdout = runCtx(tmp, ["list", "--json"]);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("--dry-run reports the real file list and writes nothing", () => {
    const res = runCtxResult(tmp, ["add", "nodes/ghost", "--title", "Ghost", "--dry-run"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Dry run — no files were written.");
    expect(res.stderr).toContain("+ nodes/ghost.md");
    expect(existsSync(join(tmp, "nodes", "ghost.md"))).toBe(false);
  });

  it("--dry-run leaves an existing document byte-identical", () => {
    runCtx(tmp, ["add", "nodes/keep", "--title", "Keep", "--body", "original"]);
    const docPath = join(tmp, "nodes", "keep.md");
    const before = readFileSync(docPath, "utf-8");

    runCtx(tmp, ["update", "nodes/keep", "--body", "rewritten", "--dry-run"]);
    expect(readFileSync(docPath, "utf-8")).toBe(before);
  });

  it("delete refuses non-interactively without --yes, and the document survives", () => {
    runCtx(tmp, ["add", "nodes/doomed", "--title", "Doomed"]);
    const res = runCtxResult(tmp, ["delete", "nodes/doomed"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Refusing without confirmation/);
    expect(existsSync(join(tmp, "nodes", "doomed.md"))).toBe(true);

    runCtx(tmp, ["delete", "nodes/doomed", "--yes"]);
    expect(existsSync(join(tmp, "nodes", "doomed.md"))).toBe(false);
  });

  it("read --out will not clobber an existing file without --force", () => {
    runCtx(tmp, ["add", "nodes/rendered", "--title", "Rendered"]);
    const outFile = join(tmp, "render.html");
    writeFileSync(outFile, "PRE-EXISTING");

    const res = runCtxResult(tmp, ["read", "nodes/rendered", "--html", "--out", outFile]);
    expect(res.status).toBe(1);
    expect(readFileSync(outFile, "utf-8")).toBe("PRE-EXISTING");

    runCtx(tmp, ["read", "nodes/rendered", "--html", "--out", outFile, "--force"]);
    expect(readFileSync(outFile, "utf-8")).toContain("<html");
  });

  it("push refuses to send vault contents over plaintext HTTP to a remote host", () => {
    const res = runCtxResult(tmp, [
      "push",
      "--server",
      "http://vault-exfil.example.com",
      "--nest",
      "n1",
      "--key",
      "cnst_test",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/plaintext HTTP/);
  });
});

// ─── file safety — dry-run fidelity ──────────────────────────────────────────
// The claim these guard is that --dry-run reports the REAL result. Four spots
// originally bypassed the sandbox and printed a hand-written "would ..." line,
// which could disagree with what the command actually does.

describe("[regression] file safety — dry-run fidelity", () => {
  it("vault add --dry-run fails on an alias collision, like the real command", () => {
    initVault(tmp);
    runCtx(tmp, ["vault", "add", "taken", tmp, "--yes"]);

    // Registering a DIFFERENT path under a taken alias needs --force. The dry
    // run must refuse it too, rather than promising a mapping that can't happen.
    const other = mkdtempSync(join(tmpdir(), "cn-other-vault-"));
    try {
      initVault(other);
      const dry = runCtxResult(tmp, ["vault", "add", "taken", other, "--dry-run"]);
      expect(dry.status).not.toBe(0);
      expect(dry.stdout + dry.stderr).toMatch(/already exists/);

      // And the dry run left the real registry alone.
      const list = JSON.parse(runCtx(tmp, ["vault", "list", "--json"]));
      const taken = list.find((v: { alias: string }) => v.alias === "taken");
      expect(taken.path).toBe(tmp);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("vault remove --dry-run fails for an alias that isn't registered", () => {
    initVault(tmp);
    const res = runCtxResult(tmp, ["vault", "remove", "never-registered", "--dry-run"]);
    expect(res.status).not.toBe(0);
  });

  it("vault add --dry-run does not write to the registry", () => {
    initVault(tmp);
    runCtx(tmp, ["vault", "add", "ghost-alias", tmp, "--dry-run"]);
    const list = JSON.parse(runCtx(tmp, ["vault", "list", "--json"]));
    expect(list.map((v: { alias: string }) => v.alias)).not.toContain("ghost-alias");
  });

  it("init --dry-run on an existing vault reports rewrites as modified, not created", () => {
    initVault(tmp);
    const res = runCtxResult(tmp, ["init", "--name", "again", "--yes", "--dry-run"]);
    expect(res.status).toBe(0);
    // config.yaml already exists, so re-initializing modifies it. Reporting it
    // as created would mean the sandbox never saw the existing vault.
    expect(res.stderr).toMatch(/~ \.context\/config\.yaml/);
    expect(res.stderr).not.toMatch(/\+ \.context\/config\.yaml/);
  });

  it("read --out --dry-run marks an existing target as modified, not created", () => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/previewed", "--title", "Previewed"]);
    const outFile = join(tmp, "preview.html");
    writeFileSync(outFile, "PRE-EXISTING");

    const res = runCtxResult(tmp, [
      "read", "nodes/previewed", "--html", "--out", outFile, "--force", "--dry-run",
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain(`~ ${outFile}`);
    expect(readFileSync(outFile, "utf-8")).toBe("PRE-EXISTING");
  });
});

// ─── file safety — consent gate coverage ─────────────────────────────────────

describe("[regression] file safety — command coverage", () => {
  // VAULT_WRITE_COMMANDS / REGISTRY_WRITE_COMMANDS in index.ts are
  // hand-maintained. A rename that misses them costs those commands their
  // --dry-run sandbox and action log with no other symptom, so assert every
  // listed name still resolves to a real command.
  const CLASSIFIED = [
    "init", "add", "update", "delete", "publish", "index", "welcome",
    "checkpoint rebuild", "drift stage", "drift approve", "drift reject",
    "vault add", "vault describe", "vault remove", "vault default",
  ];

  it.each(CLASSIFIED)("`ctx %s` still exists", (name) => {
    const res = runCtxResult(tmp, [...name.split(" "), "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Usage:/);
  });

  // Every destructive command must refuse without a TTY unless consent was
  // given up front. delete / vault remove are covered above; these are the
  // rest of the set the PR description calls out.
  it("checkpoint rebuild refuses without --yes", () => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/cp", "--title", "CP"]);
    const res = runCtxResult(tmp, ["checkpoint", "rebuild"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Refusing without confirmation/);
  });

  it("push refuses without --yes", async () => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/sendable", "--title", "Sendable"]);
    const server = await startMockEngine(() => ({
      published: 1,
      context_md_updated: false,
      node_ids: ["n0"],
    }));
    try {
      const res = runCtxResult(tmp, [
        "push", "--server", server.url, "--nest", "n1", "--key", "cnst_k",
      ]);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/Refusing without confirmation/);
      // Nothing reached the server.
      expect(server.lastBody()).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("drift approve refuses without --yes", () => {
    initVault(tmp);
    runCtx(tmp, ["add", "nodes/policy3", "--title", "Policy", "--body", "original"]);
    appendFileSync(join(tmp, "nodes", "policy3.md"), "\n\nout-of-band edit\n");
    const staged = JSON.parse(runCtx(tmp, ["drift", "stage", "nodes/policy3", "--json"]));

    const res = runCtxResult(tmp, ["drift", "approve", "nodes/policy3", staged.suggestion_id]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Refusing without confirmation/);
    // The canonical document was not rewritten.
    expect(JSON.parse(runCtx(tmp, ["drift", "list", "nodes/policy3", "--json"])).count).toBe(1);
  });
});

// ─── file safety — vault layout collisions ───────────────────────────────────

describe("[regression] file safety — generic folder names in a vault", () => {
  // The prune list keeps node_modules out of the snapshot and the dry-run copy.
  // Matching those names at any depth would make real documents invisible: a
  // vault is free-form, and "build" / "out" / "target" are ordinary words.
  beforeEach(() => initVault(tmp));

  it("logs writes to a document folder whose name collides with a build dir", () => {
    const res = runCtxResult(tmp, ["add", "nodes/build/pipeline", "--title", "Pipeline"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("+ nodes/build/pipeline.md");
  });

  it("previews such a document against a complete sandbox copy", () => {
    runCtx(tmp, ["add", "nodes/out/formats", "--title", "Formats", "--body", "original"]);
    const res = runCtxResult(tmp, ["update", "nodes/out/formats", "--body", "revised", "--dry-run"]);
    expect(res.status).toBe(0);
    // Modified, not created — the subtree made it into the sandbox copy.
    expect(res.stderr).toContain("~ nodes/out/formats.md");
    expect(readFileSync(join(tmp, "nodes", "out", "formats.md"), "utf-8")).toContain("original");
  });
});
