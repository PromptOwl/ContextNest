#!/usr/bin/env node
/**
 * Vendor the shared plugin core into each agent plugin.
 *
 * `plugins/shared/` is the single source of truth. Installed Claude plugins
 * cannot read files outside their own directory (path-traversal rule), and local
 * `--plugin-dir` only preserves in-tree symlinks — so each agent plugin keeps a
 * committed, vendored copy of the core. This script produces those copies:
 *
 *   1. Copies `plugins/shared/core/*` → `plugins/<agent>/core/*` (byte-identical).
 *   2. Fills the `<!-- BEGIN SHARED -->…<!-- END SHARED -->` region of each
 *      agent/skill markdown file from the matching `plugins/shared/prompts/*.md`.
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

const BEGIN = "<!-- BEGIN SHARED -->";
const END = "<!-- END SHARED -->";

/** Which plugins consume the shared core, and which prompt fills which file. */
const TARGETS = [
  {
    plugin: "claude-code",
    core: true,
    prompts: [
      { file: "agents/contextnest-retriever.md", prompt: "retriever" },
      { file: "agents/contextnest-capture.md", prompt: "capture" },
      { file: "skills/recall/SKILL.md", prompt: "recall" },
    ],
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
