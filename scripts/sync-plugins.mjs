#!/usr/bin/env node
/**
 * Vendor the shared plugin core into the Claude Code plugin, and render the
 * portable skills.
 *
 * `plugins/shared/` is the single source of truth. It is also the plugin root
 * for every agent except Claude Code: Codex, Gemini/Antigravity, OpenCode, Grok
 * Build, Muse Code and Zed read it in place, through a manifest or an install
 * step, so they need no copy. Claude Code keeps its own directory because it
 * runs agents (not skills) and loads every skill in its plugin root. An
 * installed Claude plugin cannot read files outside its own directory, so that
 * plugin keeps a committed copy. This script:
 *
 *   1. Copies `plugins/shared/core/*` → `plugins/claude-code/core/*` (byte-identical).
 *   2. Fills the `<!-- BEGIN SHARED -->…<!-- END SHARED -->` region of each
 *      Claude Code agent/skill markdown file from `plugins/shared/prompts/*.md`.
 *   3. Fills the same region of each portable skill
 *      (`plugins/shared/skills/<name>/SKILL.md`) from its prompt, in place.
 *
 * Usage:
 *   node scripts/sync-plugins.mjs           # write the vendored copies
 *   node scripts/sync-plugins.mjs --check    # verify in sync; exit 1 on drift
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_CORE = join(ROOT, "plugins", "shared", "core");
const SHARED_PROMPTS = join(ROOT, "plugins", "shared", "prompts");
const SHARED_SKILLS = join(ROOT, "plugins", "shared", "skills");

/** Portable skill → the prompt that fills its body. */
const SKILLS = {
  "contextnest-recall": "retriever",
  "contextnest-capture": "capture",
  "contextnest-curate": "curate",
  "contextnest-structure": "structure",
};

const BEGIN = "<!-- BEGIN SHARED -->";
const END = "<!-- END SHARED -->";

/** What the sync writes: the Claude Code copy, and the skills in the shared root. */
const TARGETS = [
  {
    plugin: "claude-code",
    core: true,
    prompts: [
      { file: "agents/contextnest-retriever.md", prompt: "retriever" },
      { file: "agents/contextnest-capture.md", prompt: "capture" },
      { file: "agents/contextnest-curator.md", prompt: "curate" },
      { file: "skills/recall/SKILL.md", prompt: "recall" },
    ],
  },
  {
    // Every other agent reads this directory in place. Do not add a target per agent.
    plugin: "shared",
    skills: true,
  },
];

const CHECK = process.argv.includes("--check");
const drift = [];
const written = [];

function read(path) {
  // Normalize CRLF so comparisons and writes are stable even when git has
  // checked the working tree out with Windows line endings.
  return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
}

/** Render a markdown file's content with the SHARED region replaced by `body`. */
function renderPromptFile(current, body) {
  const b = current.indexOf(BEGIN);
  const e = current.indexOf(END);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`missing or malformed ${BEGIN}/${END} markers`);
  }
  const before = current.slice(0, b + BEGIN.length);
  const after = current.slice(e);
  return `${before}\n${body.trim()}\n${after}`;
}

function reconcile(path, expected) {
  const actual = existsSync(path) ? read(path) : null;
  if (actual === expected) return;
  if (CHECK) {
    drift.push(relative(ROOT, path));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, expected);
  written.push(relative(ROOT, path));
}

for (const target of TARGETS) {
  const pluginDir = join(ROOT, "plugins", target.plugin);

  if (target.core) {
    const destDir = join(pluginDir, "core");
    for (const name of readdirSync(SHARED_CORE)) {
      if (!name.endsWith(".js")) continue;
      reconcile(join(destDir, name), read(join(SHARED_CORE, name)));
    }
  }

  if (target.skills) {
    for (const [name, prompt] of Object.entries(SKILLS)) {
      const wrapper = read(join(SHARED_SKILLS, name, "SKILL.md"));
      const body = read(join(SHARED_PROMPTS, `${prompt}.md`));
      reconcile(join(pluginDir, "skills", name, "SKILL.md"), renderPromptFile(wrapper, body));
    }
  }

  for (const { file, prompt } of target.prompts || []) {
    const filePath = join(pluginDir, file);
    if (!existsSync(filePath)) {
      const msg = `${target.plugin}/${file} (wrapper missing — create it with frontmatter + SHARED markers)`;
      if (CHECK) drift.push(msg);
      else throw new Error(msg);
      continue;
    }
    const body = read(join(SHARED_PROMPTS, `${prompt}.md`));
    reconcile(filePath, renderPromptFile(read(filePath), body));
  }
}

// The Claude Code plugin ships the CLI as a pinned npm dependency that Claude
// Code installs with it, so the pin must be exact and match the lockfile.
// sync can't fix this one (it needs the registry), so it fails both modes.
{
  const dir = join(ROOT, "plugins", "claude-code");
  const cli = "@promptowl/contextnest-cli";
  const pin = JSON.parse(read(join(dir, "package.json"))).dependencies?.[cli];
  const lock = existsSync(join(dir, "package-lock.json")) ? JSON.parse(read(join(dir, "package-lock.json"))) : {};
  const locked = lock.packages?.[`node_modules/${cli}`]?.version;
  if (!/^\d+\.\d+\.\d+$/.test(pin ?? "") || locked !== pin || lock.packages?.[""]?.dependencies?.[cli] !== pin) {
    console.error(
      `plugins/claude-code pins ${cli} at ${pin ?? "(none)"} but package-lock.json has ${locked ?? "(none)"}. ` +
        "Pin an exact version, then run `npm install --package-lock-only --ignore-scripts` in plugins/claude-code.",
    );
    process.exit(1);
  }
}

if (CHECK) {
  if (drift.length) {
    console.error("plugins:sync --check FAILED — vendored copies are out of date:");
    for (const d of drift) console.error(`  - ${d}`);
    console.error("\nRun `pnpm plugins:sync` and commit the result.");
    process.exit(1);
  }
  console.log("plugins:sync --check OK — all vendored copies are in sync.");
} else {
  if (written.length) {
    console.log(`plugins:sync wrote ${written.length} file(s):`);
    for (const w of written) console.log(`  - ${w}`);
  } else {
    console.log("plugins:sync — nothing to update; already in sync.");
  }
}
