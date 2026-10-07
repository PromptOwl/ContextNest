/**
 * The one writer of a nest's structure rules (§11.1, structure.ts).
 *
 * Textual, like `setReviewMode`: `writeConfig` round-trips through the Zod
 * schema, which strips keys it does not know and every comment. Here only the
 * top-level `structure`, `folders` and `templates` blocks are replaced; every
 * other byte of `.context/config.yaml` is left alone, and the result is parsed
 * and compiled before it lands.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { compileStructure, type StructureConfig } from "./structure.js";
import { withVaultLock } from "./vault-lock.js";
import type { NestStorage } from "./storage.js";

const RULE_KEYS = ["structure", "folders", "templates"] as const;
const RULE_KEY_LINE = /^(structure|folders|templates)\s*:/;

/**
 * Replace the vault's structure rules with `rules` (an empty object removes
 * them). Refuses — writing nothing — rules that do not compile, and a
 * directory that is not a vault.
 */
export async function setStructure(storage: NestStorage, rules: StructureConfig): Promise<void> {
  compileStructure(rules);
  if (!(await storage.readConfig())) {
    throw new ConfigError(`No .context/config.yaml at ${storage.root} — not a Context Nest vault.`);
  }
  await withVaultLock(storage.root, () => writeStructure(storage, rules));
}

async function writeStructure(storage: NestStorage, rules: StructureConfig): Promise<void> {
  const path = join(storage.root, ".context", "config.yaml");
  const raw = await readFile(path, "utf-8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  // Drop each top-level rule block: its key line plus the indented lines (and
  // blank lines inside them) that follow. A column-0 line — the next key or a
  // standalone comment — ends the block and is kept.
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!RULE_KEY_LINE.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      if (/^[ \t]/.test(lines[j])) {
        j++;
        continue;
      }
      if (lines[j].trim() === "") {
        let k = j;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k < lines.length && /^[ \t]/.test(lines[k])) {
          j = k;
          continue;
        }
      }
      break;
    }
    i = j - 1;
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();

  const block: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    const value = rules[key];
    if (value !== undefined && Object.keys(value).length > 0) block[key] = value;
  }
  const dumped = Object.keys(block).length
    ? yaml.dump(block, { lineWidth: -1, noRefs: true }).replace(/\n/g, eol)
    : "";
  const next = `${kept.join(eol)}${eol}${dumped}`;

  // Refuse to write a config the engine could not read back, or whose rules
  // would not compile.
  const parsed = parseConfig(next);
  compileStructure(parsed);
  await writeFile(path, next, "utf-8");
}
