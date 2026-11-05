#!/usr/bin/env node
// Turns ContextNest's CONTEXT_NEST_SPEC.md into the copy published at
// PromptOwl/context-nest-spec. The two files are byte-identical except for
// the licence line: here it points at LICENSE-SPEC and "this repository";
// in the spec repo it points at LICENSE and links back to ContextNest.
//
// The rewrite is an exact, whole-line match. If the source licence line ever
// changes, this script fails loudly instead of publishing a half-rewritten
// file — update SOURCE_LICENSE_LINE / PUBLIC_LICENSE_LINE together.
//
// Usage:
//   node scripts/spec-sync/transform-spec.mjs <in> <out>   write the public copy
//   node scripts/spec-sync/transform-spec.mjs --version <in>   print the spec version
//
// No dependencies: plain Node ESM.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE_LICENSE_LINE =
  "**License**: Apache-2.0 (see [LICENSE-SPEC](LICENSE-SPEC)) — this specification only; the reference implementation in this repository is AGPL-3.0";

export const PUBLIC_LICENSE_LINE =
  "**License**: Apache-2.0 (see [LICENSE](LICENSE)). This covers the specification only; the reference implementation in [`PromptOwl/ContextNest`](https://github.com/PromptOwl/ContextNest) is AGPL-3.0";

/** Split keeping each line's own terminator, so CRLF/LF survive untouched. */
function splitKeepingEol(text) {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter((l, i, a) => l !== "" || i < a.length - 1);
}

function stripEol(line) {
  return line.replace(/(?:\r\n|\n|\r)$/, "");
}

/** Returns the public copy of the spec. Throws unless exactly one licence line matches. */
export function transformSpec(text) {
  const lines = splitKeepingEol(text);
  const hits = lines.flatMap((l, i) => (stripEol(l) === SOURCE_LICENSE_LINE ? [i] : []));
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one source licence line, found ${hits.length}. ` +
        "The licence line in CONTEXT_NEST_SPEC.md changed: update SOURCE_LICENSE_LINE and " +
        "PUBLIC_LICENSE_LINE in scripts/spec-sync/transform-spec.mjs together.",
    );
  }
  const i = hits[0];
  const eol = lines[i].slice(stripEol(lines[i]).length);
  lines[i] = PUBLIC_LICENSE_LINE + eol;
  return lines.join("");
}

/** The value of the `**Version**: x.y` line, or throws. */
export function specVersion(text) {
  const m = text.match(/^\*\*Version\*\*:\s*([0-9A-Za-z.+-]+)\s*$/m);
  if (!m) throw new Error("no **Version**: line found in the spec");
  return m[1];
}

function main(argv) {
  if (argv[0] === "--version" && argv.length === 2) {
    process.stdout.write(specVersion(readFileSync(argv[1], "utf8")) + "\n");
    return;
  }
  if (argv.length !== 2) {
    process.stderr.write("usage: transform-spec.mjs <in> <out> | --version <in>\n");
    process.exit(2);
  }
  writeFileSync(argv[1], transformSpec(readFileSync(argv[0], "utf8")));
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
    process.stderr.write(`transform-spec: ${err.message}\n`);
    process.exit(1);
  }
}
