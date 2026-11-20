/**
 * `plugins/shared/` is the one plugin root for every agent except Claude Code.
 * Each agent reads it in place, through a manifest or an install step, so
 * there is no copy that can drift. This checks the wiring each agent reads.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const root = join(repo, "plugins", "shared");
const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), "utf-8"));
const SKILLS = [
  "contextnest-capture",
  "contextnest-curate",
  "contextnest-recall",
  "contextnest-setup",
  "contextnest-structure",
];

describe("shared plugin root", () => {
  it("holds each skill and the rules once", () => {
    const skills = readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(skills.sort()).toEqual(SKILLS);
    for (const name of SKILLS) expect(existsSync(join(root, "skills", name, "SKILL.md")), name).toBe(true);

    // Grok Build, Muse Code and Zed users copy this file into their project as AGENTS.md.
    const rules = readFileSync(join(root, "rules", "contextnest.md"), "utf-8");
    expect(rules).toContain("ContextNest Operating Rules");
    expect(rules).toContain("`/contextnest:setup` command → `contextnest-setup` skill");
  });

  it("has no hooks/hooks.json: more than one agent loads that path without being told to", () => {
    expect(existsSync(join(root, "hooks", "hooks.json"))).toBe(false);
  });

  it("Codex: the repo-root marketplace points at the root, whose manifest names it", () => {
    const entry = json(repo, ".agents", "plugins", "marketplace.json").plugins.find((p: any) => p.name === "contextnest");
    expect(resolve(repo, entry.source.path)).toBe(root);
    expect(json(root, ".codex-plugin", "plugin.json").name).toBe("contextnest");
  });

  it("Grok: the repo-root marketplace points at the skills folder, which holds a skills-only manifest", () => {
    const entry = json(repo, ".grok-plugin", "marketplace.json").plugins.find((p: any) => p.name === "contextnest");
    const pluginRoot = resolve(repo, entry.source);
    const manifest = json(pluginRoot, "plugin.json");
    expect(manifest.name).toBe("contextnest");
    expect(resolve(pluginRoot, manifest.skills)).toBe(join(root, "skills"));
    // Grok ignores the output of every hook but PreToolUse, so it gets no hooks.
    expect(manifest.hooks).toBeUndefined();
    expect(existsSync(join(pluginRoot, "hooks"))).toBe(false);
  });

  it("OpenCode: package.json main is the plugin entry", () => {
    expect(existsSync(resolve(root, json(root, "package.json").main))).toBe(true);
  });

  it("Antigravity: the root manifest names the plugin", () => {
    expect(json(root, "plugin.json").name).toBe("contextnest");
  });
});
