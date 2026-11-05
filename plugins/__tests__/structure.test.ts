/**
 * Tier 3 — structural / contract tests. No subprocess (except the sync guard).
 * Validate the manifest, hooks, marketplace entry, agent/skill frontmatter, and
 * that the vendored core is in sync with plugins/shared.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const plugin = join(repo, "plugins", "claude-code");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const read = (p: string) => readFileSync(p, "utf-8").replace(/\r\n/g, "\n");

/** Hook events this plugin relies on (subset of the documented set). */
const KNOWN_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "SessionEnd",
]);

describe("plugin manifest", () => {
  const manifest = readJson(join(plugin, ".claude-plugin", "plugin.json"));

  it("has a kebab-case name and a description", () => {
    expect(manifest.name).toBe("contextnest");
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(typeof manifest.description).toBe("string");
  });

  it("declares the userConfig options with valid types", () => {
    const keys = Object.keys(manifest.userConfig);
    // auto_capture is deprecated but retained: dropping it would silently reset
    // the enable-time answer of every existing install.
    expect(keys.sort()).toEqual([
      "auto_capture",
      "capture_mode",
      "ctx_command",
      "retrieval_mode",
      "unclear_nest",
      "vault",
    ]);
    for (const k of keys) {
      expect(["string", "number", "boolean", "directory", "file"]).toContain(manifest.userConfig[k].type);
      expect(manifest.userConfig[k].title).toBeTruthy();
      expect(manifest.userConfig[k].description).toBeTruthy();
    }
  });
});

describe("hooks.json", () => {
  const hooks = readJson(join(plugin, "hooks", "hooks.json")).hooks;

  it("registers only known events", () => {
    for (const event of Object.keys(hooks)) expect(KNOWN_EVENTS.has(event)).toBe(true);
    expect(Object.keys(hooks).sort()).toEqual([
      "PostToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("every command references an existing core script via CLAUDE_PLUGIN_ROOT", () => {
    for (const entries of Object.values<any>(hooks)) {
      for (const group of entries) {
        for (const h of group.hooks) {
          expect(h.type).toBe("command");
          expect(h.command).toContain("${CLAUDE_PLUGIN_ROOT}/core/");
          const m = h.command.match(/core\/([\w.-]+\.js)/);
          expect(m).toBeTruthy();
          expect(existsSync(join(plugin, "core", m![1]))).toBe(true);
        }
      }
    }
  });
});

describe("marketplace.json", () => {
  const mkt = readJson(join(repo, ".claude-plugin", "marketplace.json"));

  it("lists the plugin with a ./-relative source that exists", () => {
    expect(mkt.name).toBeTruthy();
    expect(mkt.owner?.name).toBeTruthy();
    const entry = mkt.plugins.find((p: any) => p.name === "contextnest");
    expect(entry).toBeTruthy();
    expect(entry.source).toMatch(/^\.\//);
    expect(entry.source).not.toContain("..");
    expect(existsSync(join(repo, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });
});

describe("agent + skill frontmatter", () => {
  const files = [
    "agents/contextnest-retriever.md",
    "agents/contextnest-capture.md",
    "agents/contextnest-curator.md",
    "skills/recall/SKILL.md",
  ];

  it.each(files)("%s has name/description frontmatter and a filled SHARED block", (rel) => {
    const text = read(join(plugin, rel));
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fm, "frontmatter present").toBeTruthy();
    const block = fm![1];
    expect(block).toMatch(/\bname:\s*\S+/);
    expect(block).toMatch(/\bdescription:\s*\S+/);
    // SHARED region exists and is non-empty after sync.
    const shared = text.match(/<!-- BEGIN SHARED -->\r?\n([\s\S]*?)\r?\n<!-- END SHARED -->/);
    expect(shared, "SHARED markers present").toBeTruthy();
    expect(shared![1].trim().length).toBeGreaterThan(50);
  });
});

describe("config command (CU-wdqcpzw825: settings must be changeable after enable)", () => {
  const commandPath = join(plugin, "commands", "config.md");

  it("ships a /contextnest:config command", () => {
    expect(existsSync(commandPath)).toBe(true);
  });

  it("command has description frontmatter and covers every setting", () => {
    const text = read(commandPath);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fm, "frontmatter present").toBeTruthy();
    expect(fm![1]).toMatch(/\bdescription:\s*\S+/);
    for (const key of ["retrieval_mode", "capture_mode", "auto_capture", "vault", "ctx_command"]) {
      expect(text).toContain(key);
    }
  });
});

describe("sweep-check hook registration", () => {
  const hooks = readJson(join(plugin, "hooks", "hooks.json")).hooks;

  it("PostToolUse is scoped to Bash and carries an explicit timeout", () => {
    const groups = hooks.PostToolUse;
    expect(groups).toHaveLength(1);
    // Matcher keeps the hook off Read/Edit/etc — it only ever inspects shell
    // commands, so firing anywhere else is pure overhead.
    expect(groups[0].matcher).toBe("Bash");
    const h = groups[0].hooks[0];
    expect(h.command).toContain("core/sweep-check.js");
    // It shells out to ctx several times across every nest (up to 45 s); run
    // synchronously it held the turn after every `ctx update`. Async, the turn
    // goes on and its findings reach the model on the next turn.
    expect(h.async).toBe(true);
    // Not enforced on an async hook today, but kept as the ceiling should the
    // hook ever run synchronously again.
    expect(typeof h.timeout).toBe("number");
    expect(h.timeout).toBeGreaterThan(0);
  });
});

describe("dispatched agents run in the background", () => {
  // The Stop hook parks work instead of blocking the turn, and the next prompt
  // dispatches it. If these lose `background: true`, the dispatch runs inline
  // and delays the user's next request instead of overlapping it.
  it.each(["agents/contextnest-capture.md", "agents/contextnest-curator.md"])(
    "%s declares background: true",
    (rel) => {
      const fm = read(join(plugin, rel)).match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
      expect(fm).toMatch(/^background:\s*true\s*$/m);
    },
  );

  it("the read-only retriever is NOT backgrounded — its answer is needed inline", () => {
    const fm = read(join(plugin, "agents/contextnest-retriever.md")).match(
      /^---\r?\n([\s\S]*?)\r?\n---/,
    )![1];
    expect(fm).not.toMatch(/background:/);
  });
});

describe("capture command", () => {
  it("ships a /contextnest:capture escape hatch with description frontmatter", () => {
    const commandPath = join(plugin, "commands", "capture.md");
    expect(existsSync(commandPath)).toBe(true);
    const text = read(commandPath);
    expect(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]).toMatch(/\bdescription:\s*\S+/);
    // The command exists precisely because capture_mode can be `off`.
    expect(text).toContain("contextnest-capture");
  });
});

describe("vendored core sync", () => {
  it("plugins:check passes (vendored core matches plugins/shared)", () => {
    // Throws (non-zero exit) if any vendored copy has drifted.
    execFileSync("node", [join(repo, "scripts", "sync-plugins.mjs"), "--check"], {
      cwd: repo,
      encoding: "utf-8",
    });
  });

  it("vendored core files are byte-identical to the shared source", () => {
    for (const name of [
      "lib.js",
      "retrieve.js",
      "session-start.js",
      "capture-gate.js",
      "signals.js",
      "ledger.js",
      "sweep-check.js",
    ]) {
      expect(read(join(plugin, "core", name))).toBe(
        read(join(repo, "plugins", "shared", "core", name)),
      );
    }
  });
});

// What the Claude plugin directory's validator reads. An unpinned npx launcher
// blocks submission, and a credential read from the environment is held even in
// a README example. https://claude.com/docs/plugins/pre-submission-checklist.md
describe("directory submission", () => {
  const cli = "@promptowl/contextnest-cli";
  const pin = readJson(join(plugin, "package.json")).dependencies[cli];
  const shipped = execFileSync("git", ["ls-files", "plugins/claude-code"], { cwd: repo, encoding: "utf-8" })
    .split("\n")
    .filter((f) => f && !f.endsWith(".png") && !f.endsWith("CHANGELOG.md") && !f.endsWith("package-lock.json"));

  it.each(["bin/ctx", "bin/ctx.cmd"])("%s falls back to npx at the exact pinned version", (rel) => {
    expect(read(join(plugin, rel))).toContain(`npx -y ${cli}@${pin} `);
  });

  it("no shipped file names an unpinned npx launch of the CLI", () => {
    const unpinned = new RegExp(`npx\\s+(?:-y\\s+)?${cli}(?!@\\d+\\.\\d+\\.\\d+)`);
    expect(shipped.filter((f) => unpinned.test(read(join(repo, f))))).toEqual([]);
  });

  it("no shipped file reads a credential from the environment", () => {
    expect(shipped.filter((f) => /--bearer-env|CONTEXTNEST_API_KEY/.test(read(join(repo, f))))).toEqual([]);
  });

  it("ships a square PNG listing icon of 512 to 2048 px under 2 MB", () => {
    const icon = readFileSync(join(plugin, ".claude-plugin", "icon.png"));
    expect(icon.subarray(1, 4).toString()).toBe("PNG");
    const [width, height] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(icon.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("the README says what the plugin runs and sends", () => {
    const readme = read(join(plugin, "README.md"));
    expect(readme).toContain("## What this plugin runs and sends");
    expect(readme).toContain("api.promptowl.ai");
    expect(readme).toContain("registry.npmjs.org");
  });
});
