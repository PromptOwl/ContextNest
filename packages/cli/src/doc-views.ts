import chalk from "./color.js";
import { TAG_PATTERN, TAG_RULE } from "@promptowl/contextnest-engine";

/**
 * Shared view shapes and formatting for commands that run against BOTH a
 * local vault and a remote nest.
 *
 * The local branches (index.ts) work on engine `ContextNode`s and the remote
 * branches (remote.ts) on catalog summaries — each maps its native objects
 * into these views, and the field selection behind every `--json` shape is
 * SINGLE-SOURCED here. Filtering is not: both branches hand their filters to
 * the nest that owns the documents. The local/remote parity regression suite
 * verifies both halves.
 */

/** The fields `ctx list` output needs, regardless of source. */
export interface DocListView {
  id: string;
  title: string;
  type?: string;
  status?: string;
  tags?: string[];
  /** Server-level remote only: the `--vault <server>/<nest>` holding this doc. */
  vault?: string;
}

/**
 * NOTE: filtering deliberately does NOT live here. Both branches send their
 * filters to the nest that owns the documents (locally the engine's
 * filters.ts, remotely the same code behind context_list), because a
 * client-side copy of those rules drifts — and cannot recover documents the
 * nest already withheld. Only field selection is shared here.
 */

/** One entry of `ctx list --json`. */
export function listJsonEntry(d: DocListView) {
  return {
    id: d.id,
    title: d.title,
    type: d.type || "document",
    status: d.status || "draft",
    tags: d.tags,
    ...(d.vault ? { vault: d.vault } : {}),
  };
}

/** Document/source-node fields `ctx query --json` selects. */
export interface QueryDocView {
  id: string;
  title: string;
  body?: string;
  source?: unknown;
  /** Present only when the served document failed integrity verification. */
  integrity?: unknown;
  /** Server-level remote only: the `--vault <server>/<nest>` holding this doc. */
  vault?: string;
}

/** The full `ctx query --json` payload shape. */
export function queryJsonPayload(p: {
  documents: QueryDocView[];
  sourceNodes: QueryDocView[];
  traceCount: number;
  mode?: string;
  hopsUsed?: number;
  nodesTraversed?: number;
}) {
  return {
    documents: p.documents.map((d) => ({
      id: d.id,
      title: d.title,
      ...(d.integrity ? { integrity: d.integrity } : {}),
      body: d.body,
      ...(d.vault ? { vault: d.vault } : {}),
    })),
    sourceNodes: p.sourceNodes.map((d) => ({
      id: d.id,
      title: d.title,
      source: d.source,
      ...(d.integrity ? { integrity: d.integrity } : {}),
      body: d.body,
      ...(d.vault ? { vault: d.vault } : {}),
    })),
    traceCount: p.traceCount,
    mode: p.mode,
    hopsUsed: p.hopsUsed,
    nodesTraversed: p.nodesTraversed,
  };
}

/** One hit of `context_search`, as the CLI renders it. */
export interface SearchHitView {
  id: string;
  title: string;
  description?: string;
  type?: string;
  /** BM25 relevance score; absent from a remote nest running an older engine. */
  score?: number;
  /** Server-level remote only: the `--vault <server>/<nest>` holding this hit. */
  vault?: string;
}

/** One entry of `ctx search --json`. */
export function searchJsonEntry(d: SearchHitView) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    type: d.type || "document",
    ...(typeof d.score === "number" ? { score: d.score } : {}),
    ...(d.vault ? { vault: d.vault } : {}),
  };
}

/** `ctx search` prints this many hits unless `--limit` says otherwise. */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Turn the parsed `--limit` value into the `limit` sent to `context_search`:
 * absent → the default; `0` → undefined, i.e. everything; `n` → `n`.
 * The option parser rejects anything else before it gets here; this guard
 * only keeps a programmatic caller honest.
 */
export function searchLimit(raw: number | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error("--limit must be 0 or a positive integer.");
  }
  return raw > 0 ? raw : undefined;
}

/**
 * Render `context_search` output, local or remote. Hits arrive best-first;
 * when `total` says the list was cut, a footer names the remainder (on
 * stderr in `--json` mode so stdout stays a parseable array).
 */
export function printSearchResults(
  out: { results: SearchHitView[]; total?: number },
  opts: { json?: boolean },
): void {
  const { results } = out;
  const total = out.total ?? results.length;
  const more = Math.max(0, total - results.length);
  const footer = `… ${more} more — raise --limit (0 = all)`;
  if (opts.json) {
    console.log(JSON.stringify(results.map(searchJsonEntry), null, 2));
    if (more > 0) console.error(chalk.dim(footer));
    return;
  }
  if (results.length === 0) {
    console.log(chalk.yellow("No results found."));
    return;
  }
  console.log(
    chalk.bold(
      more > 0 ? `Top ${results.length} of ${total} result(s):\n` : `${results.length} result(s):\n`,
    ),
  );
  for (const doc of results) {
    console.log(`  ${chalk.cyan(doc.vault ? `${doc.vault}:${doc.id}` : doc.id)}: ${doc.title}`);
  }
  if (more > 0) console.log(chalk.dim(`\n${footer}`));
}

/** Derive a display title from a doc id leaf: "nodes/foo-bar" → "Foo Bar". */
export function titleFromId(id: string): string {
  return id
    .split("/")
    .pop()!
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c: string) => c.toUpperCase());
}

/** Parse a --tags option: comma/space separated, each tag #-prefixed. */
export function parseTagsOption(tags: string): string[] {
  const parsed = tags
    .split(/[,\s]+/)
    .filter((t: string) => t.length > 0)
    .map((t: string) => (t.startsWith("#") ? t : `#${t}`));
  // Fail here, with the offending tag named, rather than deep in the engine with a bare
  // "Invalid" — the spec requires a letter first (dates and versions like 2026-09-17 or
  // 1.23.0 are not tags; prefix them: #d2026-09-17, #v1-23-0).
  const bad = parsed.filter((t) => !TAG_PATTERN.test(t));
  if (bad.length > 0) {
    throw new Error(
      `${bad.length === 1 ? "Invalid tag" : "Invalid tags"} ${bad.map((t) => JSON.stringify(t)).join(", ")} — ${TAG_RULE}`,
    );
  }
  return parsed;
}

// ─── ctx structure ─────────────────────────────────────────────────────────

/** One folder rule as `context_structure` reports it. */
export interface StructureFolderView {
  pattern: string;
  description?: string;
  types?: string[];
  folder_name?: string;
  file_name?: string;
  template?: string;
  required: boolean;
  files: Record<string, { template?: string; type?: string }>;
}

/** The `context_structure` output — printed verbatim by `ctx structure --json`. */
export interface StructureOutput {
  enforce: boolean;
  closed: boolean;
  folders: StructureFolderView[];
  templates: Record<string, { body: string; required_sections: string[] }>;
  resolved?: (StructureFolderView & { template_body?: string; required_sections?: string[] }) | null;
  violations?: Array<{ code: string; path: string; rule?: string; message: string }>;
  /** The rules do not compile: why (writes are refused only when enforced). */
  error?: string;
}

function describeRule(f: StructureFolderView): string {
  const parts: string[] = [];
  if (f.types) parts.push(f.types.length ? `types: ${f.types.join(", ")}` : "no documents directly here");
  if (f.folder_name) parts.push(`folder names: ${f.folder_name}`);
  if (f.file_name) parts.push(`file names: ${f.file_name}`);
  if (f.template) parts.push(`template: ${f.template}`);
  const files = Object.entries(f.files ?? {});
  if (files.length) {
    parts.push(`required files: ${files.map(([leaf, s]) => (s.template ? `${leaf} (${s.template})` : leaf)).join(", ")}`);
  }
  if (f.required) parts.push("required");
  return parts.join(" · ");
}

/**
 * Print `context_structure` output — shared by the local and remote branches
 * so `ctx structure` reads the same wherever the nest lives.
 */
export function printStructure(out: StructureOutput, opts: { json?: boolean; folder?: string }): void {
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.error) {
    console.log(chalk.red(`Structure rules do not compile: ${out.error}`));
    console.log(chalk.dim(out.enforce ? "Writes are refused until .context/config.yaml is fixed." : "They are not enforced, so nothing is refused."));
  } else if (out.folders.length === 0 && Object.keys(out.templates).length === 0) {
    console.log(chalk.dim("No structure rules — any folder, type and file name is allowed."));
  } else {
    const mode = out.enforce ? chalk.red("enforced") : chalk.yellow("report-only");
    const scope = out.closed ? "closed (only these folders may exist)" : "open (rules apply where they match)";
    console.log(chalk.bold(`Structure rules — ${mode}, ${scope}`));
    const width = Math.max(...out.folders.map((f) => f.pattern.length), 0);
    for (const f of out.folders) {
      const rule = describeRule(f);
      console.log(`  ${chalk.cyan(f.pattern.padEnd(width))}${rule ? `  ${rule}` : ""}`);
    }
    const templates = Object.entries(out.templates);
    if (templates.length) {
      console.log(chalk.bold("\nTemplates"));
      for (const [name, t] of templates) {
        const req = t.required_sections.length ? ` — requires: ${t.required_sections.join(", ")}` : "";
        console.log(`  ${chalk.cyan(name)}${req}`);
      }
    }
  }
  if (opts.folder !== undefined) {
    console.log(chalk.bold(`\n${opts.folder}`));
    if (!out.resolved) {
      console.log(chalk.dim(out.closed ? "  No rule governs this folder — it may not hold documents." : "  No rule governs this folder."));
    } else {
      console.log(`  rule: ${chalk.cyan(out.resolved.pattern)}${describeRule(out.resolved) ? `  ${describeRule(out.resolved)}` : ""}`);
      if (out.resolved.required_sections?.length) {
        console.log(`  required sections: ${out.resolved.required_sections.join(", ")}`);
      }
      if (out.resolved.template_body) {
        console.log(chalk.dim("  template:"));
        for (const line of out.resolved.template_body.replace(/\n$/, "").split("\n")) console.log(chalk.dim(`    ${line}`));
      }
    }
  }
  if (out.violations) {
    console.log(chalk.bold("\nCompliance"));
    if (out.violations.length === 0) console.log(chalk.green("  ✓ Everything fits the rules."));
    for (const v of out.violations) console.log(`  ${chalk.red("✗")} ${chalk.dim(v.code)} ${v.message}`);
  }
}
