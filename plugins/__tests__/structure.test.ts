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

  it("declares the four userConfig options with valid types", () => {
    const keys = Object.keys(manifest.userConfig);
    expect(keys.sort()).toEqual(["auto_capture", "ctx_command", "retrieval_mode", "vault"]);
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
    expect(Object.keys(hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
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

  it("command has description frontmatter and covers all four settings", () => {
    const text = read(commandPath);
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fm, "frontmatter present").toBeTruthy();
    expect(fm![1]).toMatch(/\bdescription:\s*\S+/);
    for (const key of ["retrieval_mode", "auto_capture", "vault", "ctx_command"]) {
      expect(text).toContain(key);
    }
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
    for (const name of ["lib.js", "retrieve.js", "session-start.js", "capture-gate.js"]) {
      expect(read(join(plugin, "core", name))).toBe(
        read(join(repo, "plugins", "shared", "core", name)),
      );
    }
  });
});
