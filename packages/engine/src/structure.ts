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
import { headingAnchor, headingAnchors } from "./inline.js";
import { NODE_TYPES, structureRulesSchema } from "./schemas.js";
import { comparableSegment } from "./storage.js";
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
  /** Whole-name match. Never the backtracking engine for an owner regex. */
  test: (name: string) => boolean;
  /**
   * name → result. A check runs the same matcher against the same name once
   * per rule and folder depth; memoizing keeps one write's regex work to one
   * run per distinct (matcher, name), however many rules share a pattern.
   */
  memo: Map<string, boolean>;
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
  /** Things that compile but are probably mistakes (an unresolved template name). */
  warnings: string[];
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
  warnings?: string[];
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * Longest name a format is ever run against. Anything longer is refused
 * outright, so an attacker-sized input never reaches a regex.
 */
export const MAX_MATCHED_NAME = 128;
/** Longest owner-written regex accepted. */
const MAX_REGEX_LENGTH = 200;
/**
 * `{slug}`/`{n}` tokens per token pattern — a readability limit (§11.1.1).
 * Cost is not the reason: token patterns run on the same linear matcher as
 * owner regexes.
 */
const MAX_VARIABLE_TOKENS = 3;
/** Folder rules allowed in one vault: bounds the rules a single check walks. */
const MAX_RULES = 256;
/** Patterns listed in a "not an allowed folder" message before eliding. */
const MAX_LISTED = 12;

// ─── Tokens ─────────────────────────────────────────────────────────────────

/**
 * What each token matches, as a regex in the §11.1.1 grammar. `slug` repeats
 * a group, which the grammar does not allow, so it is its own matcher item
 * (see `tokenItem`); its expression is listed for reference.
 */
const TOKENS: Readonly<Record<string, string>> = {
  slug: "[a-z0-9]+(?:-[a-z0-9]+)*",
  date: "[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])",
  yyyy: "[0-9]{4}",
  n: "[0-9]+",
};
const TOKEN_LIST = Object.keys(TOKENS).map((t) => `{${t}}`).join(", ");
/** Tokens whose width varies — two of them may not touch. */
const VARIABLE_TOKENS = new Set(["slug", "n"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LABEL = /^\{([a-z][a-z0-9_-]*)\}$/i;
const matcher = (spelling: string, test: (name: string) => boolean): Matcher => ({
  spelling,
  test,
  memo: new Map(),
});
/** A token pattern's items, matched like an owner regex — never by `RegExp`. */
const itemsMatcher = (spelling: string, items: RegexItem[]) =>
  matcher(spelling, (name) => linearTest([items], name));
const slugMatcher = () => itemsMatcher("{slug}", [tokenItem("slug")]);
const tokenMatcher = (token: string) => itemsMatcher(`{${token}}`, [tokenItem(token)]);

/** Whether `name` fits, never running a pattern on an over-long name. */
function fits(m: Matcher, name: string): boolean {
  if (name.length > MAX_MATCHED_NAME) return false;
  let hit = m.memo.get(name);
  if (hit === undefined) {
    hit = m.test(name);
    if (m.memo.size >= 4096) m.memo.clear();
    m.memo.set(name, hit);
  }
  return hit;
}

// ─── Owner regexes: a linear-time matcher ───────────────────────────────────

/**
 * An owner-written `/regex/` never runs on the JavaScript regex engine. That
 * engine backtracks, and every attempt to bound its backtracking by banning
 * constructs was broken in review (padded bounds, alternation chains, many
 * rules multiplying one slow pattern). Instead the whitelisted grammar is
 * parsed into this small AST and matched by position-set simulation: each
 * item turns the set of positions reachable so far into the next set, in
 * O(name length). A match costs O(items × length) — no pattern in the
 * grammar can stall a write, however it is shaped or however many rules
 * carry it. The grammar has no repeated groups, which is what keeps every
 * item a single pass.
 */
type CharTest = (code: number) => boolean;
type RegexItem =
  | { kind: "atom"; test: CharTest; min: number; max: number }
  | { kind: "group"; alternatives: RegexItem[][] }
  | { kind: "slug" }
  | { kind: "start" }
  | { kind: "end" };

const isDigit: CharTest = (c) => c >= 48 && c <= 57;
const isWord: CharTest = (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const WHITESPACE = new Set([9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
const isSpace: CharTest = (c) => WHITESPACE.has(c) || (c >= 0x2000 && c <= 0x200a);
const isLineTerminator = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const SHORTHANDS: Readonly<Record<string, CharTest>> = {
  d: isDigit,
  D: (c) => !isDigit(c),
  w: isWord,
  W: (c) => !isWord(c),
  s: isSpace,
  S: (c) => !isSpace(c),
};
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const equals = (code: number): CharTest => (c) => c === code;
const BRACE_QUANTIFIER = /\{(\d+)(?:(,)(\d*))?\}/y;

class RegexSyntaxError extends Error {}

/**
 * Parse a regex body in the §11.1.1 grammar (ECMAScript, no flags,
 * non-Unicode), refusing everything outside it.
 */
function parseRegex(src: string): RegexItem[][] {
  let i = 0;
  const fail = (why: string): never => {
    throw new RegexSyntaxError(why);
  };

  const escape = (): { shorthand: CharTest } | { char: number } => {
    const e = src[i + 1];
    if (e === undefined) fail("ends with a lone backslash");
    i += 2;
    if (Object.hasOwn(SHORTHANDS, e)) return { shorthand: SHORTHANDS[e] };
    if (!ASCII_PUNCTUATION.test(e)) {
      fail(`uses the escape \\${e} (allowed: \\d \\w \\s, their negations, and escaped ASCII punctuation)`);
    }
    return { char: e.charCodeAt(0) };
  };

  // As JavaScript reads a class: the first `]` closes it, even straight after
  // `[` or `[^`, so `[]` matches nothing and `[^]` anything. `-` between two
  // atoms is a range; when either end is a class escape (`\d-z`), Annex B
  // makes it the union of both ends and `-` — the next atom is consumed, never
  // the start of another range.
  const charClass = (): CharTest => {
    i++;
    let negate = false;
    if (src[i] === "^") {
      negate = true;
      i++;
    }
    const atom = (): CharTest | number => {
      if (src[i] !== "\\") return src.charCodeAt(i++);
      const e = escape();
      return "shorthand" in e ? e.shorthand : e.char;
    };
    const asTest = (a: CharTest | number): CharTest => (typeof a === "number" ? equals(a) : a);
    const members: CharTest[] = [];
    for (;;) {
      if (i >= src.length) fail("has an unclosed [ character class");
      if (src[i] === "]") {
        i++;
        break;
      }
      const from = atom();
      if (src[i] !== "-" || src[i + 1] === undefined || src[i + 1] === "]") {
        members.push(asTest(from));
        continue;
      }
      i++;
      const to = atom();
      if (typeof from === "number" && typeof to === "number") {
        if (to < from) fail("has a character range out of order");
        members.push((c) => c >= from && c <= to);
      } else {
        members.push(asTest(from), equals(45), asTest(to));
      }
    }
    return (c) => members.some((m) => m(c)) !== negate;
  };

  const quantifier = (): { min: number; max: number } | null => {
    const c = src[i];
    if (c === "*") return (i++, { min: 0, max: Infinity });
    if (c === "+") return (i++, { min: 1, max: Infinity });
    if (c === "?") return (i++, { min: 0, max: 1 });
    if (c !== "{") return null;
    BRACE_QUANTIFIER.lastIndex = i;
    const m = BRACE_QUANTIFIER.exec(src);
    if (!m) return fail("has an unescaped { that is not a quantifier (write \\{ for the character)");
    if (m[1].length > 3 || (m[3]?.length ?? 0) > 3) fail("has a quantifier bound longer than 3 digits");
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    if (max < min) fail("has a quantifier whose bounds are out of order");
    i += m[0].length;
    return { min, max };
  };

  const sequence = (): RegexItem[] => {
    const items: RegexItem[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") {
      const c = src[i];
      let item: RegexItem;
      if (c === "(") {
        if (src[i + 1] === "?") {
          if (src[i + 2] !== ":") fail("uses a group other than ( ) or (?: ) (no lookaround or named groups)");
          i += 3;
        } else {
          i++;
        }
        const alternatives = alternation();
        if (src[i] !== ")") fail("has an unbalanced parenthesis");
        i++;
        item = { kind: "group", alternatives };
      } else if (c === "^" || c === "$") {
        i++;
        item = { kind: c === "^" ? "start" : "end" };
      } else if (c === "[") {
        item = { kind: "atom", test: charClass(), min: 1, max: 1 };
      } else if (c === "\\") {
        const e = escape();
        item = { kind: "atom", test: "shorthand" in e ? e.shorthand : equals(e.char), min: 1, max: 1 };
      } else if (c === ".") {
        i++;
        item = { kind: "atom", test: (x) => !isLineTerminator(x), min: 1, max: 1 };
      } else if (c === "*" || c === "+" || c === "?" || c === "{") {
        return fail(c === "{" ? "has an unescaped { (write \\{ for the character)" : "has a quantifier with nothing to repeat");
      } else if (c === "}" || c === "]") {
        return fail(`has an unescaped ${c} (write \\${c} for the character)`);
      } else {
        i++;
        item = { kind: "atom", test: equals(c.charCodeAt(0)), min: 1, max: 1 };
      }
      const q = quantifier();
      if (q) {
        if (item.kind === "group") fail("repeats a group — repeat a single character or [class] instead, or use a token pattern");
        if (item.kind !== "atom") fail("has a quantifier with nothing to repeat");
        (item as { min: number; max: number }).min = q.min;
        (item as { min: number; max: number }).max = q.max;
        if (src[i] === "?") i++; // lazy: the same set of whole-name matches
        if (src[i] === "*" || src[i] === "+" || src[i] === "?" || src[i] === "{") {
          fail("has a quantifier with nothing to repeat");
        }
      }
      items.push(item);
    }
    return items;
  };

  const alternation = (): RegexItem[][] => {
    const alternatives = [sequence()];
    while (src[i] === "|") {
      i++;
      alternatives.push(sequence());
    }
    return alternatives;
  };

  const top = alternation();
  if (i < src.length) fail("has an unbalanced parenthesis");
  return top;
}

/** Positions reachable after `alternatives`, from the positions in `from`. */
function advanceAlternatives(alternatives: RegexItem[][], name: string, from: Uint8Array): Uint8Array {
  if (alternatives.length === 1) return advanceSequence(alternatives[0], name, from);
  const out = new Uint8Array(name.length + 1);
  for (const alternative of alternatives) {
    const reached = advanceSequence(alternative, name, from);
    for (let p = 0; p <= name.length; p++) out[p] |= reached[p];
  }
  return out;
}

function advanceSequence(items: RegexItem[], name: string, from: Uint8Array): Uint8Array {
  const n = name.length;
  let current = from;
  for (const item of items) {
    if (item.kind === "group") {
      current = advanceAlternatives(item.alternatives, name, current);
      continue;
    }
    const next = new Uint8Array(n + 1);
    if (item.kind === "slug") {
      // [a-z0-9]+(?:-[a-z0-9]+)* in one left-to-right pass: `word` is "a slug
      // runs up to here and ends in a letter or digit", `dash` "…ends in -".
      let word = false;
      let dash = false;
      for (let p = 0; p < n; p++) {
        const c = name.charCodeAt(p);
        const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        const nextWord: boolean = alnum && (word || dash || current[p] === 1);
        dash = c === 45 && word;
        word = nextWord;
        next[p + 1] = word ? 1 : 0;
      }
    } else if (item.kind === "start") {
      next[0] = current[0];
    } else if (item.kind === "end") {
      next[n] = current[n];
    } else {
      // run[p]: how many characters from p the atom matches in a row; from p
      // the atom ends anywhere in [p + min, p + min(max, run[p])]. Marking
      // those ranges through a difference array keeps the step linear.
      const run = new Uint32Array(n + 1);
      for (let p = n - 1; p >= 0; p--) run[p] = item.test(name.charCodeAt(p)) ? run[p + 1] + 1 : 0;
      const diff = new Int32Array(n + 2);
      for (let p = 0; p <= n; p++) {
        if (!current[p]) continue;
        const lo = p + item.min;
        const hi = p + Math.min(item.max, run[p]);
        if (lo <= hi) {
          diff[lo]++;
          diff[hi + 1]--;
        }
      }
      for (let p = 0, open = 0; p <= n; p++) {
        open += diff[p];
        next[p] = open > 0 ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

/** A token as one matcher item. */
function tokenItem(token: string): RegexItem {
  return token === "slug" ? { kind: "slug" } : { kind: "group", alternatives: parseRegex(TOKENS[token]) };
}

/** Whole-name match, as `^(?:body)$` would, in linear time. */
function linearTest(alternatives: RegexItem[][], name: string): boolean {
  const start = new Uint8Array(name.length + 1);
  start[0] = 1;
  return advanceAlternatives(alternatives, name, start)[name.length] === 1;
}

// ─── Compiling ──────────────────────────────────────────────────────────────

/** Compile a format: `/regex/` or a token pattern like `{date}-{slug}`. */
function compileFormat(spelling: string, key: string): Matcher {
  if (spelling.length >= 2 && spelling.startsWith("/") && spelling.endsWith("/")) {
    const body = spelling.slice(1, -1);
    if (!body) throw new ConfigError(`${key}: the regex is empty`);
    if (body.length > MAX_REGEX_LENGTH) {
      throw new ConfigError(`${key}: the regex ${spelling} is longer than ${MAX_REGEX_LENGTH} characters`);
    }
    let alternatives: RegexItem[][];
    try {
      alternatives = parseRegex(body);
    } catch (err) {
      if (!(err instanceof RegexSyntaxError)) throw err;
      throw new ConfigError(`${key}: the regex ${spelling} ${err.message}`);
    }
    return matcher(spelling, (name) => linearTest(alternatives, name));
  }
  if (!spelling) throw new ConfigError(`${key}: the format is empty`);
  const items: RegexItem[] = [];
  let slugs = 0;
  let variable = 0;
  let previous: string | null = null; // the token just before, if nothing separates them
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
      if (VARIABLE_TOKENS.has(token)) {
        if (previous && VARIABLE_TOKENS.has(previous)) {
          throw new ConfigError(
            `${key}: {${previous}}{${token}} — two variable-width tokens need a literal between them (e.g. "-")`,
          );
        }
        if (++variable > MAX_VARIABLE_TOKENS) {
          throw new ConfigError(`${key}: at most ${MAX_VARIABLE_TOKENS} {slug}/{n} tokens per format`);
        }
      }
      previous = token;
      items.push(tokenItem(token));
    } else {
      previous = null;
      if (!/^[a-z0-9-]+$/.test(part)) {
        throw new ConfigError(
          `${key}: "${part}" can never match — names are lowercase a-z, 0-9 and "-" (titles are slugified)`,
        );
      }
      items.push(...parseRegex(part)[0]);
    }
  }
  return itemsMatcher(spelling, items);
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

/**
 * Placeholders as `{}` and literals case-folded — two patterns with different
 * labels, or literals differing only in case, are one shape (literals match
 * case-insensitively, see `sameName`).
 */
function shapeKey(segments: Segment[]): string {
  return segments.map((s) => (isPlaceholder(s) ? "{}" : s.literal.toLowerCase())).join("/");
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
  // The config schema leaves these keys unchecked (see schemas.ts), so their
  // shape is checked here, naming the offending key.
  const shape = structureRulesSchema.safeParse({
    structure: config?.structure,
    folders: config?.folders,
    templates: config?.templates,
  });
  if (!shape.success) {
    const issue = shape.error.issues[0];
    throw new ConfigError(`${issue.path.join(".")}: ${issue.message}`);
  }
  // Null prototype: a template named `constructor` or `toString` must never
  // resolve to an inherited Object property.
  const templates: CompiledStructure["templates"] = Object.create(null);
  for (const [name, t] of Object.entries(config?.templates ?? {})) {
    const sections = [...(t?.required_sections ?? [])];
    // Sections are compared by heading anchor (§4: a-z, 0-9, "-"), so each
    // must have one, and no two may share one — or one heading would satisfy
    // several requirements.
    const seen = new Map<string, string>();
    for (const section of sections) {
      const anchor = headingAnchor(String(section));
      const key = `templates.${name}.required_sections`;
      if (!anchor) {
        throw new ConfigError(
          `${key}: "${section}" has no a-z or 0-9 characters, so no heading can be matched to it (section anchors are ASCII)`,
        );
      }
      if (seen.has(anchor)) {
        throw new ConfigError(`${key}: "${section}" and "${seen.get(anchor)}" are the same heading anchor (#${anchor})`);
      }
      seen.set(anchor, String(section));
    }
    templates[name] = { body: t?.body ?? "", required_sections: sections };
  }

  const entries = Object.entries(config?.folders ?? {});
  if (entries.length > MAX_RULES) {
    throw new ConfigError(`folders: at most ${MAX_RULES} folder rules (found ${entries.length})`);
  }
  const warnings: string[] = [];

  const rules: CompiledRule[] = [];
  const seen = new Map<string, string>();
  const placeholders: Array<{ rule: CompiledRule; index: number; key: string }> = [];

  for (const [rawKey, spec] of entries) {
    const key = `folders.${rawKey}`;
    const pattern = normalizeKey(rawKey);
    const segments: Segment[] = [];
    for (const part of pattern ? pattern.split("/") : []) {
      const label = LABEL.exec(part)?.[1];
      if (label) {
        segments.push({ label, matcher: label in TOKENS ? tokenMatcher(label) : slugMatcher() });
      } else if (part && !part.startsWith(".") && !/[{}]/.test(part)) {
        // Any folder name, not just a slug: engine-written folders are always
        // slugs, but a vault's own (`Engineering`, `my notes`) are matched
        // literally, as the spec's `folders` keys always were.
        segments.push({ literal: part });
      } else {
        throw new ConfigError(
          `${key}: "${part || "(empty)"}" in "${rawKey}" is not a folder name or a {placeholder}`,
        );
      }
    }
    const shape = shapeKey(segments);
    if (seen.has(shape)) {
      throw new ConfigError(`${key}: same folders as "${seen.get(shape)}" — declare each pattern once`);
    }
    seen.set(shape, rawKey);

    const rule = compileRule(spec ?? {}, pattern, segments, key, templates);
    const named: Array<[string, string | undefined]> = [
      [`${key}.template`, rule.template],
      ...Object.entries(rule.files).map(([leaf, f]): [string, string | undefined] => [`${key}.files.${leaf}.template`, f.template]),
    ];
    for (const [where, name] of named) {
      if (name !== undefined && !templates[name]) {
        warnings.push(`${where}: "${name}" is not defined under templates — it adds no body and requires no sections`);
      }
    }
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
    warnings: [...new Set(warnings)],
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
  // A template that names nothing under `templates` is a label (the spec's
  // `template: adr` predates structure rules): no body, no required sections.
  if (spec.template !== undefined) rule.template = spec.template;
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
    if (file?.type !== undefined) {
      assertType(file.type, `${fileKey}.type`);
      if (UNSCAFFOLDABLE_TYPES.has(file.type)) {
        throw new ConfigError(
          `${fileKey}.type: a required file cannot be a "${file.type}" — it needs data a template cannot supply (a PDF binary, a source or skill block)`,
        );
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

/**
 * Vault-ROOT folders that hold system files, never knowledge nodes. Only the
 * root ones: `nodes/packs/` is an ordinary folder like any other, or closed
 * rules would have a door anyone could walk through.
 */
const SYSTEM_ROOTS = new Set(["packs", "_suggestions"]);

/** Types a scaffolded required file cannot be: each needs data beyond a body. */
const UNSCAFFOLDABLE_TYPES = new Set(["pdf", "source", "skill"]);

const rawSegments = (path: string) =>
  path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".");

/**
 * The root a path starts in, compared as a file system resolves it — a
 * case-insensitive volume puts `Nodes/x` in `nodes/x`.
 */
const rootOf = (raw: string[]) => (raw.length > 0 ? comparableSegment(raw[0]) : "");

/** Folder segments of a path, `nodes/` dropped; null when it is exempt. */
function folderSegments(folder: string): string[] | null {
  const raw = rawSegments(folder);
  const root = rootOf(raw);
  if (SYSTEM_ROOTS.has(root) || root === "sources") return null;
  return root === "nodes" ? raw.slice(1) : raw;
}

/**
 * A document id split into folder segments and leaf; null when exempt. An id
 * is taken as it is — never extension-stripped — because storage writes
 * `<id>.md`, so `adr-1-x.md` is a file named `adr-1-x.md.md`.
 */
function docPath(id: string): { folder: string[]; leaf: string; sourcesRoot: boolean } | null {
  const raw = rawSegments(id);
  const root = rootOf(raw);
  if (raw.length === 0 || SYSTEM_ROOTS.has(root)) return null;
  // The vault's CONTEXT.md, exactly: exempting `context` too would hand a
  // case-sensitive volume a root file no rule ever judges.
  if (raw.length === 1 && raw[0] === "CONTEXT") return null;
  const segs = root === "nodes" ? raw.slice(1) : raw;
  const leaf = segs.pop();
  if (!leaf) return null;
  return { folder: segs, leaf, sourcesRoot: root === "sources" };
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
  const root = rootOf(segs) === "nodes" ? segs[0] : "";
  if (root) segs.shift();
  segs.pop();
  const folders: string[] = [];
  for (let i = 1; i <= segs.length; i++) folders.push(segs.slice(0, i).join("/"));
  return { root, folders };
}

// ─── Matching ───────────────────────────────────────────────────────────────

/**
 * Literal names compare case-insensitively: on a case-insensitive filesystem
 * (macOS, Windows) `NOTES/x` lands in `notes/`, so the `notes` rule must judge it.
 */
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function segmentFits(seg: Segment, name: string): boolean {
  return isPlaceholder(seg) ? fits(seg.matcher, name) : sameName(seg.literal, name);
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
    if (!isPlaceholder(seg) && !sameName(seg.literal, folder[i])) return false;
  }
  return true;
}

/** Code-unit order — never the host locale, so every machine sorts alike. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** At the first differing segment a literal beats a placeholder. */
function moreSpecific(a: CompiledRule, b: CompiledRule): number {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const la = !isPlaceholder(a.segments[i]);
    const lb = !isPlaceholder(b.segments[i]);
    if (la !== lb) return la ? -1 : 1;
  }
  return byCodeUnit(a.pattern, b.pattern);
}

/** The rule declared for exactly this folder, most specific first. */
function ruleAt(rules: CompiledStructure, folder: string[]): CompiledRule | null {
  const hits = rules.rules.filter((r) => r.segments.length === folder.length && fitsPrefix(r, folder));
  return hits.sort(moreSpecific)[0] ?? null;
}

function allowedList(rules: CompiledStructure): string {
  const patterns = rules.rules.map((r) => shown(r.pattern)).sort(byCodeUnit);
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
  if (p.sourcesRoot && type === "source") return [];
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
  const declared = isRequiredFile ? rule.files[p.leaf].type : undefined;
  if (declared && type !== declared) {
    out.push({
      code: "TYPE_NOT_ALLOWED",
      path,
      rule: shown(rule.pattern),
      message: `"${p.leaf}" in ${where} is a required ${declared}, not a "${type}" (rule ${shown(rule.pattern)}).`,
    });
  }
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
    } else if (!fits(rule.fileName, p.leaf)) {
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
  const have = headingAnchors(doc.body ?? "");
  const template = governingTemplate(rule, p.leaf);
  for (const section of requiredSections(rules, rule, p.leaf)) {
    if (!have.has(headingAnchor(section))) {
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
    const was = headingAnchors(before.body ?? "");
    const now = headingAnchors(after.body ?? "");
    const path = display([...p.folder, p.leaf]);
    for (const section of requiredSections(rules, rule, p.leaf)) {
      const key = headingAnchor(section);
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

/**
 * A required file goes with its folder: it cannot be deleted while the folder
 * (subfolders included) still holds `others` documents. Once it is the last
 * one it may go, so a folder can be emptied without a folder-delete operation.
 */
export function checkDeleteDocument(rules: CompiledStructure, id: string, others = 1): Violation[] {
  const p = docPath(id);
  if (!p || others === 0) return [];
  const rule = ruleAt(rules, p.folder);
  if (!rule || !Object.hasOwn(rule.files, p.leaf)) return [];
  return [
    {
      code: "MISSING_FILE",
      path: display([...p.folder, p.leaf]),
      rule: shown(rule.pattern),
      message: `"${p.leaf}" is required in "${display(p.folder)}/" (rule ${shown(rule.pattern)}) — delete the folder, or its other documents first.`,
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
  // A folder no document lives under is an emptied shell (there is no folder
  // delete to remove it): it is judged as a folder, but its required contents
  // are not reported missing.
  const occupied = new Set<string>();
  for (const path of docPaths) {
    const segs = path.split("/");
    for (let k = 1; k < segs.length; k++) occupied.add(segs.slice(0, k).join("/"));
  }
  for (const segs of segsList) {
    const chain = folderViolations(rules, segs);
    out.push(...chain);
    if (chain.length > 0 || !occupied.has(display(segs))) continue;
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
  const seen = new Set<string>();
  return out.filter((v) => {
    const key = `${v.code}\u0000${v.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    folders: rules.rules.map(viewOf).sort((a, b) => byCodeUnit(a.pattern, b.pattern)),
    templates: structuredClone(rules.templates),
    ...(rules.warnings.length > 0 ? { warnings: [...rules.warnings] } : {}),
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
