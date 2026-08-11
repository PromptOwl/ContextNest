#!/usr/bin/env node
/**
 * Generate DEPENDENCIES.md — the published dependency graph for every package
 * we ship to npm.
 *
 * Devs installing a CLI want to know exactly what lands in their node_modules
 * and why. This walks the resolved production tree of each published package
 * and writes a reviewed, committed record of it, so the answer is a file in the
 * repo rather than an `npm ls` someone has to run and interpret.
 *
 * Usage:
 *   node scripts/dep-graph.mjs           # write DEPENDENCIES.md + dependency-graph.json
 *   node scripts/dep-graph.mjs --check   # verify up to date; exit 1 on drift
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN = join(ROOT, "DEPENDENCIES.md");
const JSON_OUT = join(ROOT, "dependency-graph.json");
const CHECK = process.argv.includes("--check");

/** The packages we publish, in the order they should appear in the document. */
const PUBLISHED = [
  "@promptowl/contextnest-cli",
  "@promptowl/contextnest-engine",
  "@promptowl/contextnest-mcp-server",
];

/**
 * Why each direct runtime dependency is there. Every direct dependency of a
 * published package MUST have an entry — the script fails otherwise, so a new
 * dependency cannot be added without justifying it in the published graph.
 */
const RATIONALE = {
  "@promptowl/contextnest-engine": "The engine itself — vault storage, selectors, versioning, integrity.",
  "@modelcontextprotocol/sdk": "The Model Context Protocol server implementation the MCP package exists to serve.",
  chalk: "Terminal colour. Optional — see the minimal install profile below.",
  commander: "Command, argument and help parsing for `ctx`.",
  diff: "Unified diffs for the keyframe+diff version model and drift suggestions.",
  "js-yaml": "Reads and writes YAML frontmatter, `context.yaml`, packs and history files.",
  minisearch: "In-memory full-text index behind `ctx search` and the fast selector path.",
  toposort: "Dependency ordering for `source` node graphs.",
  zod: "Runtime validation of frontmatter and operation inputs (spec §13 rules 1–17).",
  "zod-to-json-schema": "Turns the Zod operation catalog into the JSON Schema the MCP tools publish.",
};

/** Read a package manifest from a resolved directory. */
function manifest(path) {
  try {
    return JSON.parse(readFileSync(join(path, "package.json"), "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Locate an installed dependency by walking the `node_modules` chain upwards
 * from the package that requires it — the same lookup Node itself performs, so
 * it is correct for pnpm's nested layout as well as a hoisted npm one.
 */
function resolveDep(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      // pnpm links every dependency into a shared store, and a package's own
      // dependencies are siblings of its REAL directory, not of the symlink.
      // Resolve through the link or the upward walk finds nothing.
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Walk the installed runtime tree from a package directory.
 *
 * Reads manifests directly rather than shelling out to `pnpm list`, because
 * `pnpm list --prod` omits optionalDependencies — which would hide exactly the
 * packages the minimal install profile is about.
 */
function resolveTree(rootDir, rootName) {
  // name -> { version, license, depth, parents }
  const packages = new Map();
  let maxDepth = 0;

  function walk(dir, owner, depth) {
    const pkg = manifest(dir);
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    ];

    for (const { name, optional } of deps) {
      const existing = packages.get(name);
      if (existing) {
        existing.parents.add(owner);
        existing.depth = Math.min(existing.depth, depth);
        continue;
      }

      const depDir = resolveDep(dir, name);
      if (!depDir) {
        // An optional dependency the installer chose to skip never reaches a
        // user's disk, so it does not belong in the published graph.
        if (optional) continue;
        throw new Error(
          `${name} is declared by ${owner} but is not installed. Run \`pnpm install\` first.`,
        );
      }

      const depPkg = manifest(depDir);
      maxDepth = Math.max(maxDepth, depth);
      packages.set(name, {
        version: depPkg.version ?? "",
        license: depPkg.license ?? "UNKNOWN",
        depth,
        parents: new Set([owner]),
      });
      walk(depDir, name, depth + 1);
    }
  }

  walk(rootDir, rootName, 1);
  return { packages, maxDepth };
}

/** Build the full report for every published package. */
function buildReport() {
  const report = [];

  for (const name of PUBLISHED) {
    const dir = join(ROOT, "packages", name.replace("@promptowl/contextnest-", ""));
    if (!existsSync(join(dir, "package.json"))) {
      throw new Error(`Cannot find the manifest for ${name} at ${dir}.`);
    }
    const pkg = manifest(dir);
    const required = Object.keys(pkg.dependencies ?? {});
    const optional = Object.keys(pkg.optionalDependencies ?? {});

    const missing = [...required, ...optional].filter((d) => !(d in RATIONALE));
    if (missing.length) {
      throw new Error(
        `No rationale recorded for direct dependenc${missing.length > 1 ? "ies" : "y"} ` +
          `${missing.join(", ")} of ${name}. Add an entry to RATIONALE in scripts/dep-graph.mjs.`,
      );
    }

    const { packages, maxDepth } = resolveTree(dir, name);
    report.push({
      name,
      version: pkg.version,
      required,
      optional,
      maxDepth,
      total: packages.size,
      minimalTotal: packages.size - optional.length,
      packages: [...packages.entries()]
        .map(([dep, info]) => ({
          name: dep,
          version: info.version,
          license: info.license,
          depth: info.depth,
          optional: optional.includes(dep),
          via: [...info.parents].sort(),
        }))
        .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
    });
  }

  return report;
}

/** Render the report as the committed markdown document. */
function renderMarkdown(report) {
  const out = [];
  out.push("# Dependencies");
  out.push("");
  out.push(
    "> Generated by `pnpm deps:graph`. Do not edit by hand — run the script and commit the result.",
  );
  out.push("");
  out.push(
    "Every package that lands in your `node_modules` when you install a Context Nest package, " +
      "why it is there, and under what licence. CI regenerates this file and fails on drift, so " +
      "it cannot silently fall out of date.",
  );
  out.push("");

  out.push("## Install footprint");
  out.push("");
  out.push("| Package | Runtime packages | Max depth | With `--omit=optional` |");
  out.push("| --- | --- | --- | --- |");
  for (const pkg of report) {
    out.push(
      `| \`${pkg.name}\` | ${pkg.total} | ${pkg.maxDepth} | ${pkg.minimalTotal} |`,
    );
  }
  out.push("");
  out.push(
    "Counts are unique packages in the resolved production tree, including the monorepo's own " +
      "packages. Depth is measured from the package you install.",
  );
  out.push("");

  out.push("## Install-time touchpoints");
  out.push("");
  out.push(
    "- **No install scripts.** None of the published packages define `preinstall`, `install` or " +
      "`postinstall`. Installing runs no code of ours; `--ignore-scripts` changes nothing.",
  );
  out.push(
    "- **No native builds.** Everything is plain JavaScript — no `node-gyp`, no prebuilt binaries, " +
      "no platform-specific downloads.",
  );
  out.push(
    "- **No network access at runtime** beyond what you explicitly configure for `source` nodes.",
  );
  out.push(
    "- **Where files are written.** The CLI writes only inside the vault you point it at, plus the " +
      "registry at `~/.contextnest/config.yaml`.",
  );
  out.push("");

  out.push("## Minimal install profile");
  out.push("");
  out.push("```bash");
  out.push("npm install -g @promptowl/contextnest-cli --omit=optional");
  out.push("```");
  out.push("");
  out.push(
    "Optional dependencies are presentation-only. Omitting them drops terminal colour; every " +
      "command, flag and output format behaves identically. `NO_COLOR` is a lighter-weight way to " +
      "get plain output if you already have a normal install.",
  );
  out.push("");

  for (const pkg of report) {
    out.push(`## \`${pkg.name}\``);
    out.push("");

    const direct = pkg.packages.filter((d) => d.depth === 1);
    out.push("### Direct");
    out.push("");
    out.push("| Package | Version | Licence | Required | Why |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const dep of direct) {
      out.push(
        `| \`${dep.name}\` | ${dep.version} | ${dep.license} | ${dep.optional ? "optional" : "yes"} | ${RATIONALE[dep.name]} |`,
      );
    }
    out.push("");

    const transitive = pkg.packages.filter((d) => d.depth > 1);
    out.push("### Transitive");
    out.push("");
    if (transitive.length === 0) {
      out.push("None. Every dependency is top-level.");
    } else {
      out.push("| Package | Version | Licence | Depth | Pulled in by |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const dep of transitive) {
        out.push(
          `| \`${dep.name}\` | ${dep.version} | ${dep.license} | ${dep.depth} | ${dep.via.map((v) => `\`${v}\``).join(", ")} |`,
        );
      }
    }
    out.push("");
  }

  out.push("## Verifying this yourself");
  out.push("");
  out.push("```bash");
  out.push("npm install -g @promptowl/contextnest-cli");
  out.push("npm ls -g --all --omit=dev @promptowl/contextnest-cli");
  out.push("```");
  out.push("");
  out.push(
    "CI publishes the machine-readable form of this graph as the `dependency-graph` workflow " +
      "artifact on every run.",
  );
  out.push("");

  return out.join("\n");
}

const report = buildReport();
const markdown = renderMarkdown(report);
const json = JSON.stringify({ packages: report }, null, 2) + "\n";

/** Normalize CRLF so comparisons are stable on Windows checkouts. */
function read(path) {
  return existsSync(path) ? readFileSync(path, "utf-8").replace(/\r\n/g, "\n") : null;
}

if (CHECK) {
  const drift = [];
  if (read(MARKDOWN) !== markdown) drift.push("DEPENDENCIES.md");
  if (read(JSON_OUT) !== json) drift.push("dependency-graph.json");

  if (drift.length) {
    console.error(`deps:graph --check FAILED — out of date: ${drift.join(", ")}`);
    console.error("Run `pnpm deps:graph` and commit the result.");
    process.exit(1);
  }
  console.log("deps:graph --check OK — the published dependency graph is up to date.");
} else {
  writeFileSync(MARKDOWN, markdown, "utf-8");
  writeFileSync(JSON_OUT, json, "utf-8");
  for (const pkg of report) {
    console.log(
      `${pkg.name}: ${pkg.total} runtime package(s), max depth ${pkg.maxDepth}` +
        (pkg.optional.length ? `, ${pkg.minimalTotal} with --omit=optional` : ""),
    );
  }
  console.log("\nWrote DEPENDENCIES.md and dependency-graph.json.");
}
