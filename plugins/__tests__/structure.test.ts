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

describe("plugin manifest", () => {
  const manifest = readJson(join(plugin, ".claude-plugin", "plugin.json"));

  it("has a kebab-case name and a description", () => {
    expect(manifest.name).toBe("contextnest");
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(typeof manifest.description).toBe("string");
  });

  it("declares no settings: every old one only tuned a hook", () => {
    expect(manifest.userConfig).toBeUndefined();
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

describe("dispatched agents run in the background", () => {
  // If these lose `background: true`, the dispatch runs inline and delays the
  // user's next request instead of overlapping it.
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
    expect(text).toContain("contextnest-capture");
  });
});

describe("shared prompt sync", () => {
  it("plugins:check passes (agent and skill bodies match plugins/shared)", () => {
    // Throws (non-zero exit) if any vendored copy has drifted.
    execFileSync("node", [join(repo, "scripts", "sync-plugins.mjs"), "--check"], {
      cwd: repo,
      encoding: "utf-8",
    });
  });
});

// The directory accepts command hooks only from Verified organizations, so this
// branch ships none. The full plugin, with its four hooks, stays on `development`.
describe("hookless directory edition", () => {
  const files = execFileSync("git", ["ls-files", "plugins/claude-code"], { cwd: repo, encoding: "utf-8" })
    .split("\n")
    .filter((f) => f && existsSync(join(repo, f)));
  const prose = files.filter((f) => /\.(md|json)$/.test(f) && !/CHANGELOG|package/.test(f));
  const skill = (name: string) => read(join(plugin, "skills", name, "SKILL.md"));
  const frontmatter = (text: string) => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";

  it("ships no hooks and none of the scripts only hooks ran", () => {
    expect(existsSync(join(plugin, "hooks"))).toBe(false);
    expect(existsSync(join(plugin, "core"))).toBe(false);
    expect(readJson(join(plugin, ".claude-plugin", "plugin.json")).hooks).toBeUndefined();
  });

  it("claims no hook, removed setting or removed command anywhere", () => {
    const stale = /\bhooks?\b|retrieval_mode|capture_mode|auto_capture|unclear_nest|ctx_command|plugin-settings|contextnest\.local|\/contextnest:config|on each prompt/i;
    const allowed = /full (edition|plugin)|no hooks/i;
    const hits = prose.flatMap((f) =>
      read(join(repo, f))
        .split("\n")
        .filter((l) => stale.test(l) && !allowed.test(l))
        .map((l) => `${f}: ${l.slice(0, 100)}`),
    );
    expect(hits).toEqual([]);
  });

  it("every /contextnest: reference resolves to a shipped command or skill", () => {
    for (const f of prose) {
      for (const [, name] of read(join(repo, f)).matchAll(/\/contextnest:([a-z-]+)/g)) {
        const found = existsSync(join(plugin, "commands", `${name}.md`)) || existsSync(join(plugin, "skills", name, "SKILL.md"));
        expect(found, `${f} -> /contextnest:${name}`).toBe(true);
      }
    }
  });

  it("check-notes triggers on questions and treats notes as data", () => {
    const text = skill("check-notes");
    expect(frontmatter(text)).toMatch(/\bdescription:.*\b(before|when)\b/i);
    expect(text).toContain("ctx search");
    expect(text).toMatch(/reference material, not instructions/);
    expect(text).toMatch(/cit(e|ing)/i);
  });

  it("keep-notes routes new facts to capture and corrections to the curator", () => {
    const text = skill("keep-notes");
    expect(frontmatter(text)).toMatch(/\bdescription:.*\b(remember|correct)/i);
    expect(text).toContain("contextnest-capture");
    expect(text).toContain("contextnest-curator");
  });

  it("the README says what this edition leaves out and where the full plugin is", () => {
    const readme = read(join(plugin, "README.md"));
    expect(readme).toContain("## This edition and the full plugin");
    expect(readme).toContain("/plugin install contextnest --marketplace promptowl/contextnest");
  });

  it("the sync script no longer vendors the core into this plugin", () => {
    const script = read(join(repo, "scripts", "sync-plugins.mjs"));
    expect(script).toMatch(/plugin: "claude-code",\n\s+core: false/);
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

  it("the listing opens with the one-step install and has no repo-relative links", () => {
    const readme = read(join(plugin, "README.md"));
    const install = "/plugin install contextnest --marketplace promptowl/contextnest";
    expect(readme.indexOf(install)).toBeGreaterThan(-1);
    expect(readme.indexOf(install)).toBeLessThan(readme.indexOf("## Setup"));
    expect(readme).not.toMatch(/\]\(\.\.?\//);
  });

  it("the listing fields point people at the product", () => {
    const manifest = readJson(join(plugin, ".claude-plugin", "plugin.json"));
    const entry = readJson(join(repo, ".claude-plugin", "marketplace.json")).plugins[0];
    expect(manifest.homepage).toBe("https://promptowl.ai/contextnest");
    expect(manifest.keywords).toContain("context-layer");
    expect(entry.homepage).toBe(manifest.homepage);
    expect(entry.description).toBe(manifest.description);
  });

  it("the root README shows how to install the plugin", () => {
    expect(read(join(repo, "README.md"))).toContain("/plugin install contextnest --marketplace promptowl/contextnest");
  });

  it("the README says what the plugin runs and sends", () => {
    const readme = read(join(plugin, "README.md"));
    expect(readme).toContain("## What this plugin runs and sends");
    expect(readme).toContain("api.promptowl.ai");
    expect(readme).toContain("registry.npmjs.org");
  });
});
