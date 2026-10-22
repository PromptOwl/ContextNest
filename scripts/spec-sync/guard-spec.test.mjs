#!/usr/bin/env node
// Licence & leak guard tests: the current spec (after the transform) passes,
// and an injected sample for every check fails. Plain node:test, no deps.
//   node --test scripts/spec-sync/guard-spec.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSpec } from "./transform-spec.mjs";
import {
  guardSpec, buildShingles, codeFiles, fencedBlocks, normalizeLine, isTrivial, SHINGLE,
} from "./guard-spec.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = transformSpec(readFileSync(join(ROOT, "CONTEXT_NEST_SPEC.md"), "utf8"));
const shingles = buildShingles(ROOT);

const failing = (text) => {
  const r = guardSpec(text, { shingles });
  return r.checks.filter((c) => c.findings.length).map((c) => c.id);
};

// Inject a sample just after the Abstract heading, as real prose would sit.
const inject = (sample) => PUBLIC.replace("## Abstract\n", `## Abstract\n\n${sample}\n`);

test("current spec, after the transform, passes every check", () => {
  const r = guardSpec(PUBLIC, { shingles });
  assert.deepEqual(r.checks.filter((c) => c.findings.length), []);
  assert.equal(r.ok, true);
});

test("the spec's unlabeled example blocks (frontmatter, checkpoint YAML) are present and pass", () => {
  const bare = fencedBlocks(PUBLIC).filter((b) => b.lang === "");
  assert.ok(bare.length >= 2, "expected unlabeled example blocks in the spec");
  assert.deepEqual(failing(PUBLIC), []);
});

test("the untransformed source fails: its licence line is not the allowlisted public one", () => {
  const src = readFileSync(join(ROOT, "CONTEXT_NEST_SPEC.md"), "utf8");
  assert.deepEqual(failing(src), ["licence-marker"]);
});

test("guard compares against real engine source", () => {
  const files = codeFiles(ROOT).map((f) => relative(ROOT, f));
  assert.ok(files.some((f) => f.startsWith(join("packages", "engine", "src"))));
  assert.ok(shingles.size > 1000);
});

for (const lang of ["ts", "typescript", "tsx", "js", "javascript", "mjs", "cjs", "rust", "rs", "python", "py", "go", "java", "c", "cpp", "csharp"]) {
  test(`(a) a \`\`\`${lang} block fails`, () => {
    assert.ok(failing(inject("```" + lang + "\nx\n```\n")).includes("code-fence"));
  });
}

test("(a) tilde fences and {.lang} info strings are caught too", () => {
  assert.ok(failing(inject("~~~ Python\nx\n~~~\n")).includes("code-fence"));
  assert.ok(failing(inject("```{.ts}\nx\n```\n")).includes("code-fence"));
});

/** A real engine function: the first `function` whose first 6 lines are all non-trivial. */
function realEngineFunction() {
  const files = codeFiles(ROOT).filter(
    (f) => f.includes(join("packages", "engine", "src")) && !f.includes("__tests__") && f.endsWith(".ts"),
  );
  for (const f of files.sort()) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i + 6 <= lines.length; i++) {
      if (!/^\s*(export\s+)?(async\s+)?function\s/.test(lines[i])) continue;
      const win = lines.slice(i, i + 6);
      if (win.every((l) => !isTrivial(normalizeLine(l)))) return { file: f, text: win.join("\n") };
    }
  }
  throw new Error("no 6-line engine function found");
}

test("(b) a real 6-line engine function pasted into the spec fails (even in an unlabeled block)", () => {
  const { text } = realEngineFunction();
  assert.ok(failing(inject("```\n" + text + "\n```\n")).includes("engine-copy"));
  // Re-indented and with blank lines and braces interleaved: still caught.
  const mangled = text.split("\n").map((l) => "    " + l.trim() + "\n\n}").join("\n");
  assert.ok(failing(inject(mangled)).includes("engine-copy"));
});

test(`(b) fewer than ${SHINGLE} copied lines do not trip engine-copy`, () => {
  const { text } = realEngineFunction();
  const short = text.split("\n").slice(0, SHINGLE - 1).join("\n");
  assert.ok(!failing(inject("```\n" + short + "\n```\n")).includes("engine-copy"));
});

test("(b) with no engine source to compare against, the guard fails closed", () => {
  const r = guardSpec(PUBLIC, { shingles: new Map() });
  assert.ok(r.checks.find((c) => c.id === "engine-copy").findings.length > 0);
});

for (const sample of [
  "// SPDX-License-Identifier: AGPL-3.0-only",
  "This part is licensed AGPL-3.0.",
  "GNU Affero General Public License",
  "Copyright (c) 2026 PromptOwl",
]) {
  test(`(c) licence marker fails: ${sample}`, () => {
    assert.ok(failing(inject(sample)).includes("licence-marker"));
  });
}

for (const sample of [
  'import { NestStorage } from "@promptowl/contextnest-engine";',
  "const engine = require('@promptowl/contextnest-engine');",
  "import { parse } from './parser.js';",
  "const x = require(\"fs\");",
]) {
  test(`(d) import fails: ${sample}`, () => {
    assert.ok(failing(inject(sample)).includes("code-import"));
  });
}

for (const sample of [
  "Vault at /home/someone/vault",
  "Server: 198.71.51.215",
  "Point it at 10.0.0.12 or 192.168.1.5 or 172.20.3.4",
  "Open http://localhost:3000/nests",
  "Mail ops@promptowl.ai for access",
  "See https://promptowl.slack.com/archives/C123",
  "Use key cnst_live_A1b2C3d4E5f6",
]) {
  test(`internal leak fails: ${sample}`, () => {
    assert.ok(failing(inject(sample)).includes("internal-leak"));
  });
}

test("example.com / example.org emails are allowed", () => {
  assert.deepEqual(failing(inject("Contact jane@example.com or ops@docs.example.org.")), []);
});
