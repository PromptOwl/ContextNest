/**
 * Structure rules (spec §11.1) — the nest owner's hard rules on layout:
 * which folders may exist, which node types each folder takes, the shape of
 * folder and file names (tokens or a guarded regex), the template a folder's
 * files start from and the sections they must keep, and the subfolders and
 * files every matching folder must have.
 *
 * Pure: nothing here touches the disk. `compileStructure` turns the
 * `structure` / `folders` / `templates` keys of `.context/config.yaml` into a
 * matcher, and the `check*` functions answer "would this break a rule?" with
 * a list of violations. The write operations (api/core-executors.ts) call them
 * and refuse via `enforceStructure`; `setStructure` (structure-store.ts) is
 * the one writer of the rules themselves.
 *
 * Paths are a document id (or folder) with an optional leading `nodes/`
 * removed, so structured and flat vaults are checked alike.
 */

import { ConfigError, ContextNestError } from "./errors.js";
import { NODE_TYPES } from "./schemas.js";
import type { NestConfig } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** The config keys structure rules live in. */
export type StructureConfig = Pick<NestConfig, "structure" | "folders" | "templates">;

type FolderRuleConfig = NonNullable<NestConfig["folders"]>[string];

export type ViolationCode =
  | "FOLDER_NOT_ALLOWED"
  | "FOLDER_NAME"
  | "TYPE_NOT_ALLOWED"
  | "FILE_NAME"
  | "MISSING_SECTION"
  | "MISSING_FOLDER"
  | "MISSING_FILE";

export interface Violation {
  code: ViolationCode;
  /** Content-relative path (no `nodes/`) of the folder or document at fault. */
  path: string;
  /** The rule pattern involved, when one is. */
  rule?: string;
  message: string;
}

/** What a check needs to know about a document. */
export interface StructureDoc {
  id: string;
  type?: string;
  body?: string;
}

interface Matcher {
  /** As the owner wrote it — what messages and the wire shape show. */
  spelling: string;
  re: RegExp;
}

type Segment = { literal: string } | { label: string; matcher: Matcher };

export interface CompiledRule {
  /** Normalized pattern; "" is the vault root. */
  pattern: string;
  segments: Segment[];
  description?: string;
  types?: string[];
  folderName?: Matcher;
  fileName?: Matcher;
  template?: string;
  required: boolean;
  files: Record<string, { template?: string; type?: string }>;
}

export interface CompiledStructure {
  enforce: boolean;
  closed: boolean;
  rules: CompiledRule[];
  templates: Record<string, { body: string; required_sections: string[] }>;
}

/** The wire shape of one folder rule (`context_structure`). */
export interface FolderRuleView {
  pattern: string;
  description?: string;
  types?: string[];
  folder_name?: string;
  file_name?: string;
  template?: string;
  required: boolean;
  files: Record<string, { template?: string; type?: string }>;
}

export interface ResolvedFolderRule extends FolderRuleView {
  template_body?: string;
  required_sections?: string[];
}

export interface StructureView {
  enforce: boolean;
  closed: boolean;
  folders: FolderRuleView[];
  templates: Record<string, { body: string; required_sections: string[] }>;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * Longest name a format is ever run against. Anything longer is refused
 * outright, so an attacker-sized input never reaches a regex.
 */
export const MAX_MATCHED_NAME = 128;
/** Longest owner-written regex accepted. */
const MAX_REGEX_LENGTH = 200;
/** Unbounded repetitions (`*`, `+`, `{n,}`) allowed in one regex. */
const MAX_UNBOUNDED = 3;
/** Patterns listed in a "not an allowed folder" message before eliding. */
const MAX_LISTED = 12;

// ─── Tokens ─────────────────────────────────────────────────────────────────

const TOKENS: Readonly<Record<string, string>> = {
  slug: "[a-z0-9]+(?:-[a-z0-9]+)*",
  date: "[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])",
  yyyy: "[0-9]{4}",
  n: "[0-9]+",
};
const TOKEN_LIST = Object.keys(TOKENS).map((t) => `{${t}}`).join(", ");
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LABEL = /^\{([a-z][a-z0-9_-]*)\}$/i;
const SLUG_MATCHER: Matcher = { spelling: "{slug}", re: new RegExp(`^${TOKENS.slug}$`) };

function tokenMatcher(token: string): Matcher {
  return { spelling: `{${token}}`, re: new RegExp(`^${TOKENS[token]}$`) };
}

// ─── Regex safety ───────────────────────────────────────────────────────────

/**
 * Why an owner-written regex is unsafe to run on a shared server, or null.
 *
 * Refuses the constructs that make a backtracking engine blow up: nested
 * repetition (`(a+)+`), alternation inside a repeated group (`(a|aa)*`),
 * backreferences and lookaround, and more than {@link MAX_UNBOUNDED}
 * unbounded repetitions in total (`a*a*a*a*` is polynomial in their count).
 * With inputs capped at {@link MAX_MATCHED_NAME}, what remains is bounded.
 */
function regexProblem(src: string): string | null {
  if (src.length > MAX_REGEX_LENGTH) return `is longer than ${MAX_REGEX_LENGTH} characters`;
  if (/\\[1-9]|\\k</.test(src)) return "uses a backreference";
  if (/\(\?<?[=!]/.test(src)) return "uses lookahead or lookbehind";

  interface Group {
    repeats: boolean;
    alternates: boolean;
  }
  const stack: Group[] = [{ repeats: false, alternates: false }];
  let unbounded = 0;
  // The atom a quantifier would apply to: a closed group, or anything else.
  let last: Group | "atom" | null = null;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      last = "atom";
      continue;
    }
    if (c === "[") {
      i++;
      if (src[i] === "^") i++;
      if (src[i] === "]") i++;
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "\\") i++;
        i++;
      }
      last = "atom";
      continue;
    }
    if (c === "(") {
      stack.push({ repeats: false, alternates: false });
      if (src[i + 1] === "?") {
        if (src[i + 2] === ":") i += 2;
        else if (src[i + 2] === "<") {
          const end = src.indexOf(">", i);
          i = end === -1 ? src.length : end;
        }
      }
      last = null;
      continue;
    }
    if (c === ")") {
      if (stack.length < 2) return "has an unbalanced parenthesis";
      const group = stack.pop()!;
      const parent = stack[stack.length - 1];
      parent.repeats ||= group.repeats;
      parent.alternates ||= group.alternates;
      last = group;
      continue;
    }
    if (c === "|") {
      stack[stack.length - 1].alternates = true;
      last = null;
      continue;
    }
    const q = quantifierAt(src, i);
    if (q) {
      if (q.repeating) {
        if (last && last !== "atom" && (last.repeats || last.alternates)) {
          return "repeats a group that itself repeats or alternates (exponential backtracking)";
        }
        stack[stack.length - 1].repeats = true;
      }
      if (q.unbounded && ++unbounded > MAX_UNBOUNDED) {
        return `has more than ${MAX_UNBOUNDED} unbounded repetitions (*, +, {n,})`;
      }
      i += q.length - 1;
      if (src[i + 1] === "?") i++; // lazy suffix
      last = null;
      continue;
    }
    last = "atom";
  }
  return null;
}

/** A quantifier starting at `i`, or null if `src[i]` is not one. */
function quantifierAt(
  src: string,
  i: number,
): { length: number; repeating: boolean; unbounded: boolean } | null {
  const c = src[i];
  if (c === "*" || c === "+") return { length: 1, repeating: true, unbounded: true };
  if (c === "?") return { length: 1, repeating: false, unbounded: false };
  if (c !== "{") return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
  if (!m) return null;
  const min = Number(m[1]);
  const open = m[2] !== undefined && m[3] === "";
  const max = m[2] === undefined ? min : open ? Infinity : Number(m[3]);
  return { length: m[0].length, repeating: max > 1, unbounded: open };
}

// ─── Compiling ──────────────────────────────────────────────────────────────

/** Compile a format: `/regex/` or a token pattern like `{date}-{slug}`. */
function compileFormat(spelling: string, key: string): Matcher {
  if (spelling.length >= 2 && spelling.startsWith("/") && spelling.endsWith("/")) {
    const body = spelling.slice(1, -1);
    if (!body) throw new ConfigError(`${key}: the regex is empty`);
    const problem = regexProblem(body);
    if (problem) throw new ConfigError(`${key}: the regex ${spelling} ${problem}`);
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${body})$`);
    } catch (err) {
      throw new ConfigError(`${key}: ${spelling} is not a valid regex (${(err as Error).message})`);
    }
    return { spelling, re };
  }
  if (!spelling) throw new ConfigError(`${key}: the format is empty`);
  let source = "";
  let slugs = 0;
  for (const part of spelling.split(/(\{[^}]*\})/)) {
    if (!part) continue;
    const token = /^\{(.*)\}$/.exec(part)?.[1];
    if (token !== undefined) {
      if (!(token in TOKENS)) {
        throw new ConfigError(`${key}: unknown token {${token}} — use ${TOKEN_LIST} or a /regex/`);
      }
      if (token === "slug" && ++slugs > 1) {
        throw new ConfigError(`${key}: a name format may contain at most one {slug}`);
      }
      source += TOKENS[token];
    } else {
      if (!/^[a-z0-9-]+$/.test(part)) {
        throw new ConfigError(
          `${key}: "${part}" can never match — names are lowercase a-z, 0-9 and "-" (titles are slugified)`,
        );
      }
      source += part;
    }
  }
  return { spelling, re: new RegExp(`^${source}$`) };
}

/** `"/nodes/a/b/"` → `"a/b"`; `"/"`, `""` and `"nodes"` → `""` (the root). */
function normalizeKey(key: string): string {
  let k = key.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (k === "nodes") k = "";
  else if (k.startsWith("nodes/")) k = k.slice("nodes/".length);
  return k;
}

function isPlaceholder(seg: Segment): seg is { label: string; matcher: Matcher } {
  return "label" in seg;
}

/** Placeholders as `{}` — two patterns with different labels are one shape. */
function shapeKey(segments: Segment[]): string {
  return segments.map((s) => (isPlaceholder(s) ? "{}" : s.literal)).join("/");
}

function assertType(type: string, key: string): void {
  if (!(NODE_TYPES as readonly string[]).includes(type)) {
    throw new ConfigError(`${key}: unknown node type "${type}" (one of ${NODE_TYPES.join(", ")})`);
  }
}

/**
 * Compile the rules in a config. Throws `ConfigError` (CONFIG_ERROR) naming
 * the offending key when a rule can never work. A config with no rules
 * compiles to an empty, report-only rule set.
 */
export function compileStructure(config: StructureConfig | null | undefined): CompiledStructure {
  const templates: CompiledStructure["templates"] = {};
  for (const [name, t] of Object.entries(config?.templates ?? {})) {
    templates[name] = { body: t?.body ?? "", required_sections: [...(t?.required_sections ?? [])] };
  }

  const rules: CompiledRule[] = [];
  const seen = new Map<string, string>();
  const placeholders: Array<{ rule: CompiledRule; index: number; key: string }> = [];

  for (const [rawKey, spec] of Object.entries(config?.folders ?? {})) {
    const key = `folders.${rawKey}`;
    const pattern = normalizeKey(rawKey);
    const segments: Segment[] = [];
    for (const part of pattern ? pattern.split("/") : []) {
      const label = LABEL.exec(part)?.[1];
      if (label) {
        segments.push({ label, matcher: label in TOKENS ? tokenMatcher(label) : SLUG_MATCHER });
      } else if (SLUG.test(part)) {
        segments.push({ literal: part });
      } else {
        throw new ConfigError(
          `${key}: "${part || "(empty)"}" in "${rawKey}" is neither a lowercase folder name (a-z, 0-9, "-") nor a {placeholder}`,
        );
      }
    }
    const shape = shapeKey(segments);
    if (seen.has(shape)) {
      throw new ConfigError(`${key}: same folders as "${seen.get(shape)}" — declare each pattern once`);
    }
    seen.set(shape, rawKey);

    const rule = compileRule(spec ?? {}, pattern, segments, key, templates);
    segments.forEach((s, index) => {
      if (isPlaceholder(s) && !(s.label in TOKENS)) placeholders.push({ rule, index, key });
    });
    rules.push(rule);
  }

  // A placeholder's format is the folder_name of the rule that declares that
  // exact folder (`clients/{client}`), wherever else the placeholder appears
  // (`clients/{client}/meetings`). Undeclared, it is any slug.
  const byShape = new Map(rules.map((r) => [shapeKey(r.segments), r]));
  for (const { rule, index } of placeholders) {
    const owner = byShape.get(shapeKey(rule.segments.slice(0, index + 1)));
    const seg = rule.segments[index] as { label: string; matcher: Matcher };
    if (owner?.folderName) seg.matcher = owner.folderName;
  }

  return {
    enforce: config?.structure?.enforce === true,
    closed: config?.structure?.closed === true,
    rules,
    templates,
  };
}

function compileRule(
  spec: FolderRuleConfig,
  pattern: string,
  segments: Segment[],
  key: string,
  templates: CompiledStructure["templates"],
): CompiledRule {
  const trailing = segments[segments.length - 1];
  const rule: CompiledRule = { pattern, segments, required: false, files: {} };
  if (spec.description) rule.description = spec.description;

  if (spec.types) {
    for (const t of spec.types) assertType(t, `${key}.types`);
    rule.types = [...spec.types];
  }
  if (spec.folder_name !== undefined) {
    if (!trailing || !isPlaceholder(trailing)) {
      throw new ConfigError(
        `${key}.folder_name: only a pattern ending in a {placeholder} can constrain its folder name`,
      );
    }
    rule.folderName = compileFormat(spec.folder_name, `${key}.folder_name`);
    trailing.matcher = rule.folderName;
  }
  if (spec.file_name !== undefined) rule.fileName = compileFormat(spec.file_name, `${key}.file_name`);
  if (spec.template !== undefined) {
    if (!templates[spec.template]) {
      throw new ConfigError(`${key}.template: no template "${spec.template}" in templates`);
    }
    rule.template = spec.template;
  }
  if (spec.required) {
    if (!trailing || isPlaceholder(trailing)) {
      throw new ConfigError(
        `${key}.required: only a fixed-name subfolder can be required (a {placeholder} folder cannot be created for you)`,
      );
    }
    rule.required = true;
  }
  for (const [leaf, file] of Object.entries(spec.files ?? {})) {
    const fileKey = `${key}.files.${leaf}`;
    if (!SLUG.test(leaf)) {
      throw new ConfigError(`${fileKey}: "${leaf}" is not a file name (lowercase a-z, 0-9, "-")`);
    }
    if (file?.template !== undefined && !templates[file.template]) {
      throw new ConfigError(`${fileKey}.template: no template "${file.template}" in templates`);
    }
    if (file?.type !== undefined) {
      assertType(file.type, `${fileKey}.type`);
      if (file.type === "pdf") {
        throw new ConfigError(`${fileKey}.type: a required file cannot be a PDF — a PDF needs its binary`);
      }
    }
    rule.files[leaf] = {
      ...(file?.template !== undefined ? { template: file.template } : {}),
      ...(file?.type !== undefined ? { type: file.type } : {}),
    };
  }
  return rule;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Top-level folders that hold system files, never knowledge nodes. */
const SYSTEM_ROOTS = new Set(["packs", "_suggestions"]);

/** Folder segments of a path, `nodes/` dropped; null when it is exempt. */
function folderSegments(folder: string): string[] | null {
  const segs = folder.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (segs[0] === "nodes") segs.shift();
  if (segs.some((s) => s.startsWith("."))) return null;
  if (segs.length > 0 && (SYSTEM_ROOTS.has(segs[0]) || segs[0] === "sources")) return null;
  return segs;
}

/** A document id split into folder segments and leaf; null when exempt. */
function docPath(id: string): { folder: string[]; leaf: string } | null {
  const segs = id
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .split("/")
    .filter((s) => s && s !== ".");
  if (segs[0] === "nodes") segs.shift();
  const leaf = segs.pop();
  if (!leaf) return null;
  if (leaf.startsWith(".") || segs.some((s) => s.startsWith("."))) return null;
  if (segs.length > 0 && SYSTEM_ROOTS.has(segs[0])) return null;
  if (leaf === "INDEX" || (segs.length === 0 && leaf.toLowerCase() === "context")) return null;
  return { folder: segs, leaf };
}

const display = (segs: string[]) => segs.join("/");
const shown = (pattern: string) => pattern || "/";

/**
 * The vault-relative folders a document id sits in, innermost last, with the
 * root they hang off (`nodes` in a structured vault, "" in a flat one). The
 * executors ask storage which of these exist before a write, to know which
 * folders that write brings into being.
 */
export function documentFolders(id: string): { root: string; folders: string[] } {
  const segs = id.replace(/\\/g, "/").split("/").filter(Boolean);
  const root = segs[0] === "nodes" ? "nodes" : "";
  if (root) segs.shift();
  segs.pop();
  const folders: string[] = [];
  for (let i = 1; i <= segs.length; i++) folders.push(segs.slice(0, i).join("/"));
  return { root, folders };
}

// ─── Matching ───────────────────────────────────────────────────────────────

function segmentFits(seg: Segment, name: string): boolean {
  if (!isPlaceholder(seg)) return seg.literal === name;
  return name.length <= MAX_MATCHED_NAME && seg.matcher.re.test(name);
}

/** The first `n` segments of `rule` fit `folder` (formats included). */
function fitsPrefix(rule: CompiledRule, folder: string[], n = folder.length): boolean {
  if (rule.segments.length < n) return false;
  for (let i = 0; i < n; i++) if (!segmentFits(rule.segments[i], folder[i])) return false;
  return true;
}

/** Like {@link fitsPrefix} but ignoring placeholder formats. */
function shapesPrefix(rule: CompiledRule, folder: string[], n = folder.length): boolean {
  if (rule.segments.length < n) return false;
  for (let i = 0; i < n; i++) {
    const seg = rule.segments[i];
    if (!isPlaceholder(seg) && seg.literal !== folder[i]) return false;
  }
  return true;
}

/** At the first differing segment a literal beats a placeholder. */
function moreSpecific(a: CompiledRule, b: CompiledRule): number {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const la = !isPlaceholder(a.segments[i]);
    const lb = !isPlaceholder(b.segments[i]);
    if (la !== lb) return la ? -1 : 1;
  }
  return a.pattern.localeCompare(b.pattern);
}

/** The rule declared for exactly this folder, most specific first. */
function ruleAt(rules: CompiledStructure, folder: string[]): CompiledRule | null {
  const hits = rules.rules.filter((r) => r.segments.length === folder.length && fitsPrefix(r, folder));
  return hits.sort(moreSpecific)[0] ?? null;
}

function allowedList(rules: CompiledStructure): string {
  const patterns = rules.rules.map((r) => shown(r.pattern)).sort();
  const listed = patterns.slice(0, MAX_LISTED).join(", ");
  return patterns.length > MAX_LISTED ? `${listed}, … (${patterns.length} in all)` : listed;
}

/**
 * Violations of the folder chain itself: every level must be a declared
 * folder or an ancestor of one (under `closed`), and every placeholder level
 * must fit its format (always — a rule applies wherever its shape matches).
 */
function folderViolations(rules: CompiledStructure, folder: string[]): Violation[] {
  for (let k = 1; k <= folder.length; k++) {
    const prefix = folder.slice(0, k);
    if (rules.rules.some((r) => fitsPrefix(r, prefix, k))) continue;
    const shaped = rules.rules.filter((r) => shapesPrefix(r, prefix, k)).sort(moreSpecific);
    if (shaped.length > 0) {
      const rule = shaped[0];
      const seg = rule.segments[k - 1] as { label: string; matcher: Matcher };
      const name = prefix[k - 1];
      const why =
        name.length > MAX_MATCHED_NAME
          ? `"${name.slice(0, 24)}…" is longer than ${MAX_MATCHED_NAME} characters`
          : `the {${seg.label}} folder name must look like ${seg.matcher.spelling}`;
      return [
        {
          code: "FOLDER_NAME",
          path: display(prefix),
          rule: shown(rule.pattern),
          message: `"${display(prefix)}/" doesn't fit ${shown(rule.pattern)}: ${why}.`,
        },
      ];
    }
    if (!rules.closed) return [];
    return [
      {
        code: "FOLDER_NOT_ALLOWED",
        path: display(prefix),
        message: `"${display(prefix)}/" is not an allowed folder. Allowed: ${allowedList(rules)}.`,
      },
    ];
  }
  return [];
}

// ─── Sections ───────────────────────────────────────────────────────────────

const normHeading = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** The ATX headings of a markdown body, normalized; fenced code is skipped. */
function headings(body: string): Set<string> {
  const out = new Set<string>();
  let fence: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimStart();
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    let i = 0;
    while (i < line.length && line[i] === "#") i++;
    if (i === 0 || i > 6 || (i < line.length && line[i] !== " " && line[i] !== "\t")) continue;
    let text = line.slice(i).trim();
    let j = text.length;
    while (j > 0 && text[j - 1] === "#") j--;
    if (j < text.length && (j === 0 || text[j - 1] === " " || text[j - 1] === "\t")) {
      text = text.slice(0, j).trim();
    }
    out.add(normHeading(text));
  }
  return out;
}

/** The template governing a document's sections: its required-file entry's, else its folder's. */
function governingTemplate(rule: CompiledRule, leaf: string): string | undefined {
  return Object.hasOwn(rule.files, leaf) ? rule.files[leaf].template : rule.template;
}

function requiredSections(rules: CompiledStructure, rule: CompiledRule, leaf: string): string[] {
  const name = governingTemplate(rule, leaf);
  return name ? (rules.templates[name]?.required_sections ?? []) : [];
}

// ─── Checks ─────────────────────────────────────────────────────────────────

/** Everything about this document that breaks a rule (create, move, import, audit). */
export function checkDocument(rules: CompiledStructure, doc: StructureDoc): Violation[] {
  const p = docPath(doc.id);
  if (!p) return [];
  const type = doc.type ?? "document";
  if (p.folder[0] === "sources" && type === "source") return [];
  const path = display([...p.folder, p.leaf]);

  const chain = folderViolations(rules, p.folder);
  if (chain.length > 0) return chain;

  const rule = ruleAt(rules, p.folder);
  if (!rule) {
    if (!rules.closed) return [];
    return [
      {
        code: "FOLDER_NOT_ALLOWED",
        path: display(p.folder),
        message:
          p.folder.length === 0
            ? `Documents can't be placed at the top level. Allowed: ${allowedList(rules)}.`
            : `Documents can't be placed directly in "${display(p.folder)}/" — it only holds folders. Allowed: ${allowedList(rules)}.`,
      },
    ];
  }

  const out: Violation[] = [];
  const isRequiredFile = Object.hasOwn(rule.files, p.leaf);
  const where = p.folder.length ? `"${display(p.folder)}/"` : "the top level";
  if (rule.types && !isRequiredFile && !rule.types.includes(type)) {
    out.push({
      code: "TYPE_NOT_ALLOWED",
      path,
      rule: shown(rule.pattern),
      message:
        rule.types.length === 0
          ? `Nothing may be placed directly in ${where} (rule ${shown(rule.pattern)}).`
          : `A "${type}" can't go in ${where}: ${shown(rule.pattern)} allows ${rule.types.join(", ")}.`,
    });
  }
  if (rule.fileName && !isRequiredFile) {
    if (p.leaf.length > MAX_MATCHED_NAME) {
      out.push({
        code: "FILE_NAME",
        path,
        rule: shown(rule.pattern),
        message: `File name "${p.leaf.slice(0, 24)}…" is longer than ${MAX_MATCHED_NAME} characters, the most a name rule checks.`,
      });
    } else if (!rule.fileName.re.test(p.leaf)) {
      out.push({
        code: "FILE_NAME",
        path,
        rule: shown(rule.pattern),
        message:
          `File names in ${where} must look like ${rule.fileName.spelling}; "${p.leaf}" does not. ` +
          `A file is named after its title (lowercased, words joined by "-"), so title the document to fit.`,
      });
    }
  }
  const have = headings(doc.body ?? "");
  const template = governingTemplate(rule, p.leaf);
  for (const section of requiredSections(rules, rule, p.leaf)) {
    if (!have.has(normHeading(section))) {
      out.push({
        code: "MISSING_SECTION",
        path,
        rule: shown(rule.pattern),
        message: `"${path}" needs a "${section}" heading (required by the ${template} template).`,
      });
    }
  }
  return out;
}

/**
 * What an in-place edit newly breaks — the grandfathering rule. The id cannot
 * change, so only two things can: a re-type into a type the folder refuses,
 * and dropping a required heading the body had. Anything that was already
 * out of line stays editable.
 */
export function checkUpdate(
  rules: CompiledStructure,
  before: StructureDoc,
  after: StructureDoc,
): Violation[] {
  const p = docPath(after.id);
  if (!p) return [];
  const out: Violation[] = [];
  if ((before.type ?? "document") !== (after.type ?? "document")) {
    const had = new Set(checkDocument(rules, before).map((v) => `${v.code} ${v.path}`));
    out.push(
      ...checkDocument(rules, after).filter(
        (v) =>
          (v.code === "TYPE_NOT_ALLOWED" || v.code === "FOLDER_NOT_ALLOWED") && !had.has(`${v.code} ${v.path}`),
      ),
    );
  }
  const rule = ruleAt(rules, p.folder);
  if (rule) {
    const was = headings(before.body ?? "");
    const now = headings(after.body ?? "");
    const path = display([...p.folder, p.leaf]);
    for (const section of requiredSections(rules, rule, p.leaf)) {
      const key = normHeading(section);
      if (was.has(key) && !now.has(key)) {
        out.push({
          code: "MISSING_SECTION",
          path,
          rule: shown(rule.pattern),
          message: `This edit would remove the required "${section}" heading from "${path}" (${governingTemplate(rule, p.leaf)} template).`,
        });
      }
    }
  }
  return out;
}

/** Whether a folder may exist (create, move target). */
export function checkFolder(rules: CompiledStructure, folder: string): Violation[] {
  const segs = folderSegments(folder);
  if (!segs || segs.length === 0) return [];
  return folderViolations(rules, segs);
}

/** A required file cannot be deleted on its own. */
export function checkDeleteDocument(rules: CompiledStructure, id: string): Violation[] {
  const p = docPath(id);
  if (!p) return [];
  const rule = ruleAt(rules, p.folder);
  if (!rule || !Object.hasOwn(rule.files, p.leaf)) return [];
  return [
    {
      code: "MISSING_FILE",
      path: display([...p.folder, p.leaf]),
      rule: shown(rule.pattern),
      message: `"${p.leaf}" is required in "${display(p.folder)}/" (rule ${shown(rule.pattern)}) — delete the folder instead.`,
    },
  ];
}

/** A required subfolder cannot be deleted on its own. */
export function checkDeleteFolder(rules: CompiledStructure, folder: string): Violation[] {
  const segs = folderSegments(folder);
  if (!segs || segs.length === 0) return [];
  const rule = ruleAt(rules, segs);
  if (!rule?.required) return [];
  return [
    {
      code: "MISSING_FOLDER",
      path: display(segs),
      rule: shown(rule.pattern),
      message: `"${display(segs)}/" is a required folder (rule ${shown(rule.pattern)}) — delete its parent folder instead.`,
    },
  ];
}

// ─── Scaffolding ────────────────────────────────────────────────────────────

const titleOf = (leaf: string) =>
  leaf
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** Fixed-name required subfolders of a folder, as their literal names. */
function requiredChildren(rules: CompiledStructure, folder: string[]): string[] {
  const names = new Set<string>();
  for (const r of rules.rules) {
    const last = r.segments[r.segments.length - 1];
    if (r.required && r.segments.length === folder.length + 1 && last && !isPlaceholder(last) && fitsPrefix(r, folder)) {
      names.add(last.literal);
    }
  }
  return [...names];
}

/**
 * What a write that creates `folders` must also create: their required
 * subfolders (recursively) and required files, each file starting from its
 * template. Paths are content-relative (no `nodes/`). Placeholder folders are
 * never planned — there is no name to give them.
 */
export function scaffoldPlan(
  rules: CompiledStructure,
  folders: string[],
): { folders: string[]; documents: Array<{ path: string; title: string; type: string; body: string }> } {
  const plannedFolders = new Set<string>();
  const documents = new Map<string, { path: string; title: string; type: string; body: string }>();
  const visit = (segs: string[]) => {
    const rule = ruleAt(rules, segs);
    if (rule) {
      for (const [leaf, spec] of Object.entries(rule.files)) {
        const path = display([...segs, leaf]);
        if (!documents.has(path)) {
          documents.set(path, {
            path,
            title: titleOf(leaf),
            type: spec.type ?? "document",
            body: spec.template ? (rules.templates[spec.template]?.body ?? "") : "",
          });
        }
      }
    }
    for (const child of requiredChildren(rules, segs)) {
      const next = [...segs, child];
      const key = display(next);
      if (plannedFolders.has(key)) continue;
      plannedFolders.add(key);
      visit(next);
    }
  };
  for (const folder of folders) {
    const segs = folderSegments(folder);
    if (segs && segs.length > 0) visit(segs);
  }
  return { folders: [...plannedFolders], documents: [...documents.values()] };
}

// ─── Audit / read ───────────────────────────────────────────────────────────

/**
 * The compliance report: every existing document and folder that breaks a
 * rule, plus required subfolders and files that are missing.
 */
export function auditStructure(
  rules: CompiledStructure,
  docs: StructureDoc[],
  folders: string[],
): Violation[] {
  const out: Violation[] = [];
  const docPaths = new Set<string>();
  for (const doc of docs) {
    out.push(...checkDocument(rules, doc));
    const p = docPath(doc.id);
    if (p) docPaths.add(display([...p.folder, p.leaf]));
  }
  const folderSet = new Set<string>();
  const segsList: string[][] = [];
  for (const f of folders) {
    const segs = folderSegments(f);
    if (!segs || segs.length === 0) continue;
    folderSet.add(display(segs));
    segsList.push(segs);
  }
  for (const segs of segsList) {
    const chain = folderViolations(rules, segs);
    out.push(...chain);
    if (chain.length > 0) continue;
    const rule = ruleAt(rules, segs);
    for (const child of requiredChildren(rules, segs)) {
      const path = display([...segs, child]);
      if (!folderSet.has(path)) {
        out.push({
          code: "MISSING_FOLDER",
          path,
          message: `"${display(segs)}/" is missing its required "${child}/" folder.`,
        });
      }
    }
    if (!rule) continue;
    for (const leaf of Object.keys(rule.files)) {
      const path = display([...segs, leaf]);
      if (!docPaths.has(path)) {
        out.push({
          code: "MISSING_FILE",
          path,
          rule: shown(rule.pattern),
          message: `"${display(segs)}/" is missing its required "${leaf}" file.`,
        });
      }
    }
  }
  return out;
}

function viewOf(rule: CompiledRule): FolderRuleView {
  return {
    pattern: shown(rule.pattern),
    ...(rule.description ? { description: rule.description } : {}),
    ...(rule.types ? { types: [...rule.types] } : {}),
    ...(rule.folderName ? { folder_name: rule.folderName.spelling } : {}),
    ...(rule.fileName ? { file_name: rule.fileName.spelling } : {}),
    ...(rule.template ? { template: rule.template } : {}),
    required: rule.required,
    files: structuredClone(rule.files),
  };
}

/** The rule governing one folder, with its template body; null if none. */
export function resolveFolder(rules: CompiledStructure, folder: string): ResolvedFolderRule | null {
  const segs = folderSegments(folder);
  if (!segs) return null;
  const rule = ruleAt(rules, segs);
  if (!rule) return null;
  const template = rule.template ? rules.templates[rule.template] : undefined;
  return {
    ...viewOf(rule),
    ...(template ? { template_body: template.body, required_sections: [...template.required_sections] } : {}),
  };
}

/** The whole rule set in the `context_structure` wire shape. */
export function describeStructure(rules: CompiledStructure): StructureView {
  return {
    enforce: rules.enforce,
    closed: rules.closed,
    folders: rules.rules.map(viewOf).sort((a, b) => a.pattern.localeCompare(b.pattern)),
    templates: structuredClone(rules.templates),
  };
}

/**
 * Refuse a write that breaks an enforced rule. Report-only rules (and a
 * clean write) never throw.
 */
export function enforceStructure(rules: CompiledStructure, violations: Violation[]): void {
  if (!rules.enforce || violations.length === 0) return;
  throw new ContextNestError(
    `${violations.map((v) => v.message).join(" ")} See \`ctx structure\` (context_structure) for this nest's rules.`,
    "VALIDATION_FAILED",
  );
}
