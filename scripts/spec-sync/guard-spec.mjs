#!/usr/bin/env node
// Licence & leak guard for the public spec copy (PromptOwl/context-nest-spec,
// Apache-2.0). Run on the TRANSFORMED spec before anything is pushed. It is
// fail-closed: any finding exits 1, and the sync does not push.
//
// The spec text is PromptOwl-authored prose published under Apache-2.0. The
// engine, CLI and MCP server in this repository are AGPL-3.0. These checks
// make sure no AGPL code, licence header, import, or internal detail rides
// along into the Apache-2.0 repo:
//
//   code-fence     (a) fenced code blocks tagged with anything but the
//                      allowlisted example languages (yaml, markdown, bash, …)
//   engine-copy    (b) >= 5 consecutive non-trivial lines that also appear in
//                      packages/*/src/** or packages/*/bin/**, or in code files
//                      under plugins/ and scripts/ (normalized-line
//                      shingles; trivial = short, brace-only or comment-only)
//   licence-marker (c) SPDX / AGPL / GNU Affero / Copyright (c), except the
//                      exact allowlisted lines below
//   code-import    (d) imports/requires of @promptowl/contextnest-*, relative
//                      `from './…'`, any `require(`
//   internal-leak      home paths, our VPS / private IPs, localhost URLs,
//                      non-example emails, our Slack workspace, cnst_ keys
//
// Usage:
//   node scripts/spec-sync/guard-spec.mjs <spec.md> [--code-root <dir>] [--report <file.md>]
// --code-root defaults to the repository root (two levels up). --report writes
// a markdown table of results (for the job summary and the PR body).
//
// No dependencies: plain Node ESM.

import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Fence info strings the spec may use. Anything else — ts, js, py, rust, go,
// ruby, php, … — fails: an allowlist, so a language nobody thought of is
// caught too.
export const ALLOWED_FENCE_LANGS = new Set([
  "", "yaml", "yml", "markdown", "md", "bash", "sh", "shell", "console",
  "json", "text", "txt", "plaintext", "diff",
]);

// Lines allowed to carry a licence marker. Exact whole-line matches only: if
// any of these change, the guard fails and the change gets a human look.
export const LICENCE_LINE_ALLOWLIST = new Set([
  // §0 header — written by transform-spec.mjs
  "**License**: Apache-2.0 (see [LICENSE](LICENSE)). This covers the specification only; the reference implementation in [`PromptOwl/ContextNest`](https://github.com/PromptOwl/ContextNest) is AGPL-3.0",
  // §15 Open Source Components table
  "| Context Engine (`@promptowl/context-engine`) | AGPL-3.0 | Reference implementation of selectors, versioning, storage, and source node resolution |",
  "| MCP Server (`@contextnest/mcp-server`) | AGPL-3.0 | Model Context Protocol server for vault access, including source dependency resolution and hydration relay |",
  "| CLI (`contextnest-cli`) | AGPL-3.0 | Command-line tools for vault operations |",
]);

export const SHINGLE = 5;
const MIN_LINE = 20;

const ALLOWED_EMAIL_DOMAINS = /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i;

const LICENCE_MARKERS = [/SPDX-License-Identifier/i, /\bAGPL/i, /GNU\s+Affero/i, /Copyright\s*\(c\)/i];

const IMPORT_PATTERNS = [
  [/@promptowl\/contextnest-/i, "@promptowl/contextnest-* package reference"],
  [/\bfrom\s+['"]\.{1,2}\//, "relative import (from './…')"],
  [/\brequire\s*\(/, "require("],
  [/^\s*import\s+[^;]*\s+from\s+['"]/, "ES import statement"],
];

const LEAK_PATTERNS = [
  [/\/home\/[A-Za-z0-9._-]+/, "home directory path"],
  [/\/Users\/[A-Za-z0-9._-]+\//, "home directory path"],
  [/\b198\.71\.51\.215\b/, "internal server IP"],
  [/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/, "private IP"],
  [/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i, "localhost URL"],
  [/promptowl\.slack\.com/i, "internal Slack workspace"],
  [/\bcnst_[A-Za-z0-9_-]{8,}/, "cnst_ API key"],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Line as compared for engine-copy: trimmed, whitespace collapsed. */
export function normalizeLine(line) {
  return line.trim().replace(/\s+/g, " ");
}

/** Lines that carry no signal on their own and are skipped on both sides. */
export function isTrivial(norm) {
  if (norm.length < MIN_LINE) return true;
  if (/^[\s{}()[\];,]*$/.test(norm)) return true;
  if (/^(?:\/\/|\/\*|\*\/?|<!--)/.test(norm)) return true; // comment-only
  return false;
}

/**
 * Spec-side only: peel markdown/comment prefixes (`* `, `- `, `> `, `1. `,
 * `// `, `# `) so code dressed up as a bullet list, quote or comment is still
 * compared. Code-side comment lines stay trivial, so prose never matches them.
 */
export function stripSpecPrefixes(norm) {
  let prev;
  do {
    prev = norm;
    norm = norm.replace(/^(?:[*+>-]|\d+[.)]|\/\/+|\/\*+|#+)\s*/, "");
  } while (norm !== prev);
  return norm;
}

function significant(text, { spec = false } = {}) {
  const out = [];
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    let n = normalizeLine(raw);
    if (spec) n = stripSpecPrefixes(n);
    if (!isTrivial(n)) out.push({ n, line: i + 1 });
  });
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

/** Every source file the engine-copy check compares against. */
export function codeFiles(codeRoot) {
  const files = [];
  for (const base of ["packages", join("core", "packages")]) {
    const root = join(codeRoot, base);
    if (!existsSync(root)) continue;
    for (const pkg of readdirSync(root)) {
      for (const sub of ["src", "bin"]) {
        const d = join(root, pkg, sub);
        if (existsSync(d) && statSync(d).isDirectory()) files.push(...walk(d));
      }
    }
  }
  // The rest of the repo's code: plugins and scripts (code files only — their
  // markdown prompts legitimately quote the spec). This guard's own folder is
  // skipped: its tests hold injected samples by design.
  const CODE_EXT = /\.(?:[cm]?[jt]sx?|sh)$/;
  const self = join(codeRoot, "scripts", "spec-sync");
  for (const base of ["plugins", "scripts"]) {
    const d = join(codeRoot, base);
    if (!existsSync(d)) continue;
    for (const f of walk(d)) if (CODE_EXT.test(f) && !f.startsWith(self)) files.push(f);
  }
  return files;
}

/** Map of shingle -> "file:line" for every SHINGLE-run of significant lines. */
export function buildShingles(codeRoot) {
  const map = new Map();
  for (const f of codeFiles(codeRoot)) {
    const buf = readFileSync(f);
    if (buf.includes(0)) continue; // binary
    const sig = significant(buf.toString("utf8"));
    for (let i = 0; i + SHINGLE <= sig.length; i++) {
      const key = sig.slice(i, i + SHINGLE).map((s) => s.n).join("\n");
      if (!map.has(key)) map.set(key, `${relative(codeRoot, f)}:${sig[i].line}`);
    }
  }
  return map;
}

/** Opening fences with their info-string language, CommonMark-ish. */
export function fencedBlocks(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const blocks = [];
  let open = null;
  lines.forEach((l, i) => {
    // Any indentation, not CommonMark's 0-3 spaces: a fence nested in a list
    // item is still a code block, and this guard fails closed.
    const m = l.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!m) return;
    if (!open) {
      // CommonMark: a backtick fence's info string cannot contain a backtick
      // (```ts``` is inline code, not a fence).
      if (m[1][0] === "`" && m[2].includes("`")) return;
      const info = m[2].trim();
      const lang = info.split(/\s+/)[0].replace(/^\{?\.?/, "").replace(/[},].*$/, "").toLowerCase();
      open = { fence: m[1], line: i + 1, lang };
      blocks.push(open);
    } else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length && m[2].trim() === "") {
      open = null;
    }
  });
  return blocks;
}

/**
 * Runs every check. Returns { checks: [{id, label, findings: [..]}], ok }.
 * `shingles` may be passed in (tests reuse one map).
 */
export function guardSpec(text, { codeRoot, shingles } = {}) {
  const lines = text.split(/\r\n|\n|\r/);
  const checks = [
    { id: "code-fence", label: "(a) code blocks are only unlabeled/yaml/markdown/bash/json/text/diff", findings: [] },
    { id: "engine-copy", label: `(b) no ${SHINGLE}+ line runs copied from packages/*/src+bin, plugins/, scripts/`, findings: [] },
    { id: "licence-marker", label: "(c) no SPDX / AGPL / GNU Affero / Copyright (c) outside the allowlisted lines", findings: [] },
    { id: "code-import", label: "(d) no @promptowl/contextnest-* imports, relative imports or require(", findings: [] },
    { id: "internal-leak", label: "no home paths, internal/private IPs, localhost URLs, real emails, internal Slack, cnst_ keys", findings: [] },
  ];
  const [fence, copy, licence, imports, leak] = checks;

  lines.forEach((l, i) => {
    if (/<(?:pre|script)\b/i.test(l)) fence.findings.push(`line ${i + 1}: raw HTML <pre>/<script> block`);
  });
  for (const b of fencedBlocks(text)) {
    if (!ALLOWED_FENCE_LANGS.has(b.lang)) fence.findings.push(`line ${b.line}: \`\`\`${b.lang} block`);
  }

  if (!shingles) {
    if (!codeRoot) throw new Error("guardSpec needs codeRoot or shingles");
    shingles = buildShingles(codeRoot);
  }
  if (shingles.size === 0) {
    copy.findings.push("no engine source found to compare against (wrong --code-root?) — failing closed");
  }
  const sig = significant(text, { spec: true });
  let lastHit = -Infinity;
  for (let i = 0; i + SHINGLE <= sig.length; i++) {
    const key = sig.slice(i, i + SHINGLE).map((s) => s.n).join("\n");
    const src = shingles.get(key);
    if (src && i > lastHit + SHINGLE - 1) {
      copy.findings.push(`lines ${sig[i].line}-${sig[i + SHINGLE - 1].line} match ${src}`);
      lastHit = i;
    }
  }

  lines.forEach((l, i) => {
    const at = `line ${i + 1}`;
    if (!LICENCE_LINE_ALLOWLIST.has(l) && LICENCE_MARKERS.some((re) => re.test(l))) {
      licence.findings.push(`${at}: ${l.trim().slice(0, 120)}`);
    }
    for (const [re, what] of IMPORT_PATTERNS) if (re.test(l)) imports.findings.push(`${at}: ${what}`);
    for (const [re, what] of LEAK_PATTERNS) if (re.test(l)) leak.findings.push(`${at}: ${what}`);
    for (const m of l.matchAll(EMAIL)) {
      if (!ALLOWED_EMAIL_DOMAINS.test(m[0])) leak.findings.push(`${at}: email outside example.com/.org/.net`);
    }
  });

  return { checks, ok: checks.every((c) => c.findings.length === 0) };
}

/** Markdown table for the job summary / PR body. Findings never echo secrets (line + kind only, except licence/copy). */
export function reportMarkdown(result) {
  const rows = result.checks.map(
    (c) => `| ${c.findings.length ? "FAIL" : "pass"} | ${c.label} | ${c.findings.length ? c.findings.slice(0, 10).join("<br>") : "—"} |`,
  );
  return ["| Result | Check | Findings |", "|---|---|---|", ...rows].join("\n") + "\n";
}

function main(argv) {
  const spec = argv[0];
  let codeRoot = fileURLToPath(new URL("../../", import.meta.url));
  let report = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--code-root") codeRoot = argv[++i];
    else if (argv[i] === "--report") report = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!spec) throw new Error("usage: guard-spec.mjs <spec.md> [--code-root <dir>] [--report <file.md>]");
  const result = guardSpec(readFileSync(spec, "utf8"), { codeRoot });
  const md = reportMarkdown(result);
  if (report) writeFileSync(report, md);
  process.stdout.write(md);
  if (!result.ok) {
    process.stderr.write("guard-spec: licence & leak guard FAILED — nothing will be pushed.\n");
    process.exit(1);
  }
}

// Compare real paths: a symlinked checkout or a differently-cased Windows path
// must still run main(), never exit 0 having checked nothing.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`guard-spec: ${err.message}\n`);
    process.exit(1);
  }
}
