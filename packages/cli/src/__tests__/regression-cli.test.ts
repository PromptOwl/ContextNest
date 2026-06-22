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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "..", "..", "dist", "index.js");

const ENV = { ...process.env, CONTEXTNEST_NO_BROWSER: "1" } as NodeJS.ProcessEnv;

/** Run the CLI and return stdout. Throws on a non-zero exit. */
function runCtx(cwd: string, args: string[]): string {
  return execFileSync("node", [distPath, ...args], {
    cwd,
    env: ENV,
    encoding: "utf-8",
  });
}

/**
 * Run the CLI tolerating failure. Returns the exit status plus captured
 * stdout/stderr so error-path assertions don't have to wrap try/catch.
 */
function runCtxResult(
  cwd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [distPath, ...args], {
      cwd,
      env: ENV,
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
}

function initVault(cwd: string): void {
  execFileSync(
    "node",
    [distPath, "init", "--name", "regression-vault", "--layout", "structured"],
    { cwd, env: ENV, stdio: "ignore" },
  );
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
    // init seeds v1; the publish on add bumps to v2.
    expect(out).toMatch(/Version: 2/);
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
    // add landed at v2; a content update cuts v3.
    expect(out).toMatch(/Version: 3/);

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
    expect(out).toMatch(/Version: 3/);
    expect(out).toMatch(/Chain hash: sha256:/);
  });

  it("history --json records published versions with chain hashes", () => {
    runCtx(tmp, ["publish", "nodes/release", "-m", "cut"]);
    const history = JSON.parse(runCtx(tmp, ["history", "nodes/release", "--json"]));
    const versions = history.versions.map((v: { version: number }) => v.version);
    expect(versions).toContain(2);
    expect(versions).toContain(3);
    for (const v of history.versions) {
      expect(v.chain_hash).toMatch(/^sha256:/);
    }
  });

  it("reconstruct returns the serialized content for a known version", () => {
    const content = runCtx(tmp, ["reconstruct", "nodes/release", "2"]);
    expect(content).toMatch(/title:\s*Release Doc/);
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

    const out = runCtx(tmp, ["delete", "nodes/disposable"]);
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
      join(tmp, "nodes", ".versions", "sealed", "v2.md"),
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
    const out = runCtx(tmp, ["checkpoint", "rebuild"]);
    expect(out).toMatch(/Rebuilt \d+ checkpoints/);
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
