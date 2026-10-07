/**
 * Structure rules (§11.1.1, structure.ts) meet the disk here: reading the
 * enforced rule set, finding the folders a write creates, scaffolding what
 * those folders require, and `setStructure`, the one writer of the rules.
 *
 * Every write surface — the engine executors, approvals, `ctx pull`, the
 * legacy MCP tools, and Community's own folder/move paths — goes through
 * these, so none of them re-implements scaffolding or the enforce gate.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import yaml from "js-yaml";
import { parseConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { assertNotForgotten } from "./forget.js";
import { generateIndexMd } from "./index-md-generator.js";
import { parseDocument, serializeDocument, validateDocument } from "./parser.js";
import {
  checkUpdate,
  compileStructure,
  enforceStructure,
  documentFolders,
  scaffoldPlan,
  type CompiledStructure,
  type StructureConfig,
} from "./structure.js";
import { withVaultLock } from "./vault-lock.js";
import type { NestStorage } from "./storage.js";
import type { ContextNode, Frontmatter } from "./types.js";

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * The vault's rules when they are ENFORCED, else null. Writes check only
 * this: a vault whose rules are report-only (or absent, or a legacy
 * `folders:` block) is written exactly as before, and a rule that does not
 * compile can refuse writes only in a vault that asked for enforcement.
 */
export async function enforcedStructure(storage: NestStorage): Promise<CompiledStructure | null> {
  const config = await storage.readConfig();
  if (config?.structure?.enforce !== true) return null;
  return compileStructure(config);
}

/**
 * Refuse an edit — given as the raw bytes before and after — that newly
 * breaks an enforced rule. For writes that bypass the operation executors
 * (approving a drift suggestion or a held edit, `ctx pull`, legacy tools).
 */
export async function assertStructureUpdate(
  storage: NestStorage,
  id: string,
  beforeRaw: string,
  afterRaw: string,
): Promise<void> {
  const rules = await enforcedStructure(storage);
  if (!rules) return;
  const view = (raw: string) => {
    const node = parseDocument(`${id}.md`, raw, id);
    return { id, type: node.frontmatter.type, body: node.body };
  };
  enforceStructure(rules, checkUpdate(rules, view(beforeRaw), view(afterRaw)));
}

// ─── Scaffolding ────────────────────────────────────────────────────────────

/**
 * The folders a write of document `id` would bring into existence, as
 * content-relative paths, with the root they hang off (`nodes` or "").
 * Ask BEFORE the write; hand the answer to {@link scaffoldFolders} after it.
 */
export async function missingFolders(
  storage: NestStorage,
  id: string,
): Promise<{ root: string; folders: string[] }> {
  const { root, folders } = documentFolders(id);
  const missing: string[] = [];
  for (const folder of folders) {
    if (!(await storage.hasVaultFile(root ? `${root}/${folder}` : folder))) missing.push(folder);
  }
  return { root, folders: missing };
}

/**
 * Create what newly created folders must contain: required subfolders and
 * required files, each file a draft from its template. Best effort, and it
 * never throws — the write that created the folders has already happened, so
 * failing now would strand it (done on disk, reported as failed, refused on
 * retry). Whatever could not be created stays missing and the compliance
 * report (`context_structure` with `report`) names it.
 *
 * @returns the ids of the documents it wrote.
 */
export async function scaffoldFolders(
  storage: NestStorage,
  rules: CompiledStructure,
  created: { root: string; folders: string[] },
): Promise<string[]> {
  if (created.folders.length === 0) return [];
  const plan = scaffoldPlan(rules, created.folders);
  const at = (path: string) => (created.root ? `${created.root}/${path}` : path);
  const written: string[] = [];
  for (const folder of plan.folders) {
    const rel = at(folder);
    try {
      if (await storage.hasVaultFile(rel)) continue;
      const name = folder.split("/").pop() ?? folder;
      await storage.writeIndexMd(rel, generateIndexMd(rel, name.replace(/-/g, " "), []));
    } catch {
      // left missing — reported, see above
    }
  }
  const now = new Date().toISOString();
  for (const doc of plan.documents) {
    const id = at(doc.path);
    try {
      if (await storage.hasVaultFile(`${id}.md`)) continue;
      const frontmatter: Frontmatter = {
        title: doc.title,
        type: doc.type as Frontmatter["type"],
        status: "draft",
        version: 1,
        created_at: now,
        updated_at: now,
      };
      const node: ContextNode = { id, filePath: "", rawContent: "", frontmatter, body: doc.body };
      if (!validateDocument(node).valid) continue;
      await assertNotForgotten(storage, node);
      await storage.writeDocument(id, serializeDocument(node), { exclusive: true });
      written.push(id);
    } catch {
      // left missing — reported, see above
    }
  }
  if (written.length > 0) {
    await storage.regenerateIndex({ changedIds: written }).catch(() => undefined);
  }
  return written;
}

// ─── Writing the rules ──────────────────────────────────────────────────────

const RULE_KEYS = ["structure", "folders", "templates"] as const;
const RULE_KEY_LINE = /^(structure|folders|templates)\s*:/;

/**
 * Replace the vault's structure rules with `rules` (an empty object removes
 * them). Refuses — writing nothing — rules that do not compile, a directory
 * that is not a vault, and any rewrite it cannot prove leaves the rest of the
 * file meaning exactly what it meant.
 *
 * Textual, like `setReviewMode`: `writeConfig` round-trips through the Zod
 * schema, which strips unknown keys and every comment. Only the top-level
 * rule blocks are replaced; every other line keeps its own bytes and line
 * ending, and a BOM stays.
 */
export async function setStructure(storage: NestStorage, rules: StructureConfig): Promise<void> {
  compileStructure(rules);
  if (!(await storage.readConfig())) {
    throw new ConfigError(`No .context/config.yaml at ${storage.root} — not a Context Nest vault.`);
  }
  await withVaultLock(storage.root, () => writeStructure(storage, rules));
}

/** Split keeping each line's terminator, so untouched lines go back byte-for-byte. */
function linesWithEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const body = (line: string) => line.replace(/\r?\n$/, "");
const indented = (line: string) => /^[ \t]/.test(line);
const blankOrComment = (line: string) => /^\s*(#.*)?$/.test(body(line));

/** The parsed config without the rule keys — what a rewrite must not change. */
function withoutRules(raw: string): unknown {
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const rest = { ...(parsed as Record<string, unknown>) };
  for (const key of RULE_KEYS) delete rest[key];
  return rest;
}

async function writeStructure(storage: NestStorage, rules: StructureConfig): Promise<void> {
  const path = join(storage.root, ".context", "config.yaml");
  const original = await readFile(path, "utf-8");
  const bom = original.startsWith("﻿") ? "﻿" : "";
  const raw = original.slice(bom.length);
  const lines = linesWithEnds(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";

  // Drop each top-level rule block: its key line and every following line up
  // to the next column-0 key. Blank lines and comments — column-0 ones too —
  // belong to the block when an indented line follows them.
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!RULE_KEY_LINE.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length) {
      if (indented(lines[j]) && !blankOrComment(lines[j])) {
        j++;
        continue;
      }
      if (blankOrComment(lines[j])) {
        let k = j;
        while (k < lines.length && blankOrComment(lines[k])) k++;
        if (k < lines.length && indented(lines[k])) {
          j = k;
          continue;
        }
      }
      break;
    }
    i = j - 1;
  }
  if (kept.length > 0 && !kept[kept.length - 1].endsWith("\n")) kept[kept.length - 1] += eol;

  const block: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    const value = rules[key];
    if (value !== undefined && Object.keys(value).length > 0) block[key] = value;
  }
  const dumped = Object.keys(block).length
    ? yaml.dump(block, { lineWidth: -1, noRefs: true }).replace(/\n/g, eol)
    : "";
  const next = `${kept.join("")}${dumped}`;

  // Prove the rewrite: the rest of the config means what it meant, the rule
  // blocks read back as given, and the result parses and compiles. Anything
  // else (document markers, flow-style blocks, anchors) is refused, not guessed.
  let faithful = false;
  try {
    const readBack = (yaml.load(next) ?? {}) as Record<string, unknown>;
    const rulesBack = Object.fromEntries(
      RULE_KEYS.filter((k) => readBack[k] !== undefined).map((k) => [k, readBack[k]]),
    );
    faithful =
      isDeepStrictEqual(withoutRules(raw), withoutRules(next)) && isDeepStrictEqual(rulesBack, block);
  } catch {
    faithful = false;
  }
  if (!faithful) {
    throw new ConfigError(
      `Could not rewrite the structure rules in ${path} safely — edit its structure/folders/templates keys by hand.`,
    );
  }
  compileStructure(parseConfig(next));
  await writeFile(path, `${bom}${next}`, "utf-8");
}
