#!/usr/bin/env node
// Runs the transform on the CONTEXT_NEST_SPEC.md in this checkout and diffs
// the result against what PromptOwl/context-nest-spec should hold: the same
// file with only the licence line rewritten. Plain node:test, no deps.
//   node --test scripts/spec-sync/transform-spec.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSpec, specVersion } from "./transform-spec.mjs";

const SPEC = fileURLToPath(new URL("../../CONTEXT_NEST_SPEC.md", import.meta.url));

// Written out literally (not imported) so a typo in the script is caught here.
const EXPECTED_PUBLIC_LINE =
  "**License**: Apache-2.0 (see [LICENSE](LICENSE)). This covers the specification only; the reference implementation in [`PromptOwl/ContextNest`](https://github.com/PromptOwl/ContextNest) is AGPL-3.0";

test("current spec: only the licence line differs, and it matches the spec repo's", () => {
  const src = readFileSync(SPEC, "utf8");
  const out = transformSpec(src);
  const a = src.split("\n");
  const b = out.split("\n");
  assert.equal(b.length, a.length, "line count must not change");
  const changed = a.flatMap((l, i) => (l.replace(/\r$/, "") !== b[i].replace(/\r$/, "") ? [i] : []));
  assert.deepEqual(changed.length, 1, `expected 1 changed line, got ${changed.length}`);
  assert.equal(b[changed[0]].replace(/\r$/, ""), EXPECTED_PUBLIC_LINE);
  assert.ok(a[changed[0]].startsWith("**License**: Apache-2.0 (see [LICENSE-SPEC]"));
});

test("running the transform on an already-public copy fails loudly", () => {
  const out = transformSpec(readFileSync(SPEC, "utf8"));
  assert.throws(() => transformSpec(out), /expected exactly one source licence line, found 0/);
});

test("preserves CRLF line endings", () => {
  const src = readFileSync(SPEC, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const out = transformSpec(src);
  assert.ok(out.includes(EXPECTED_PUBLIC_LINE + "\r\n"));
  assert.equal(out.split("\r\n").length, src.split("\r\n").length);
});

test("version is parsed from the **Version** line", () => {
  assert.match(specVersion(readFileSync(SPEC, "utf8")), /^\d+\.\d+(\.\d+)?$/);
  assert.equal(specVersion("# X\n\n**Version**: 1.2\n"), "1.2");
  assert.throws(() => specVersion("# X\n"), /no \*\*Version\*\*/);
});
