/**
 * `ctx import jats` / `ctx import pubmed` / `ctx enrich pubtator` — the logic,
 * kept out of index.ts so it can be exercised without spawning the CLI.
 *
 * The flow is the same for every entry point: turn each article into a
 * markdown twin (engine `jatsToDocument`), skip the ones the vault already
 * holds at the same `source_sha256`, resolve in-vault citations, and hand the
 * batch to `context_import` as `files` with `overwrite` — ONE checkpoint, one
 * index regeneration, per-file failures reported rather than aborting.
 */

import { promises as fs } from "node:fs";
import * as pathMod from "node:path";
import {
  jatsToDocument,
  linkCitations,
  buildCitationIndex,
  splitJatsArticles,
  normalizeFolder,
  parseDocument,
  serializeDocument,
  JATS_IMPORTER_VERSION,
  type ContextNode,
  type NestStorage,
} from "@promptowl/contextnest-engine";
import type { OperationContext } from "@promptowl/contextnest-engine/api";
import {
  efetchPmc,
  esearch,
  meshTag,
  pubtatorFetch,
  resolvePmid,
  type NcbiOptions,
  type PubTatorSummary,
} from "./pubmed.js";

export interface ApiRunner {
  run<T = unknown>(name: string, input: Record<string, unknown>, ctx: OperationContext): Promise<T>;
}

export interface ImportSummary {
  published: Array<{ id: string; version: number }>;
  skipped: string[];
  failed: Array<{ id?: string; title?: string; error: string }>;
  relinked: string[];
  checkpoint: number | null;
  warnings: string[];
}

interface ImportResult {
  published: Array<{ id: string; version: number }>;
  failed: Array<{ id?: string; title?: string; error: string }>;
  checkpoint: number | null;
  warnings?: string[];
}

export interface JatsSource {
  /** Display name recorded as `metadata.source_path` (a file name or a PMCID). */
  name: string;
  xml: string;
}

export interface ImportJatsOptions {
  storage: NestStorage;
  api: ApiRunner;
  ctx: OperationContext;
  sources: JatsSource[];
  /** Vault folder for twins (default `nodes/papers`). */
  folder?: string;
  /** Also write the original XML to `assets/jats/<slug>.jats.xml` in the vault. */
  keepXml?: boolean;
  /** Re-link papers already in the vault whose references now resolve (default true). */
  relink?: boolean;
  /** Republish twins whose XML is unchanged (default false). */
  force?: boolean;
}

function metadataOf(node: ContextNode): Record<string, unknown> {
  return (node.frontmatter.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Papers already in the vault under `folder` — rejected ones included, so a
 * steward's decision to retire a paper is seen by the dedup check rather than
 * bypassed by a re-import that cannot see the node it would overwrite.
 */
async function existingPapers(storage: NestStorage, folder: string): Promise<ContextNode[]> {
  const docs = await storage.discoverDocuments({ includeRetired: true });
  const prefix = `${normalizeFolder(folder)}/`;
  return docs.filter((d) => d.id.startsWith(prefix) && typeof metadataOf(d).source_sha256 === "string");
}

/** Stage `files` and publish them as one batch (one checkpoint). */
async function publishFiles(
  api: ApiRunner,
  ctx: OperationContext,
  files: Array<{ path: string; content: string }>,
): Promise<ImportResult> {
  // `files` only stages; the ids publish them in the same batch. Paths are
  // already slugs, so the staged id is the final id.
  return api.run<ImportResult>(
    "context_import",
    { files, ids: files.map((f) => f.path.replace(/\.md$/, "")), overwrite: true },
    ctx,
  );
}

/** Read every `*.xml` / `*.nxml` under the given paths (files or directories). */
export async function collectJatsFiles(paths: string[]): Promise<JatsSource[]> {
  const out: JatsSource[] = [];
  const visit = async (p: string, display: string) => {
    const st = await fs.stat(p);
    if (st.isDirectory()) {
      const entries = (await fs.readdir(p, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
        await visit(pathMod.join(p, e.name), pathMod.posix.join(display, e.name));
      }
      return;
    }
    if (!/\.(xml|nxml)$/i.test(p)) return;
    out.push({ name: display, xml: await fs.readFile(p, "utf8") });
  };
  for (const p of paths) await visit(p, pathMod.basename(p));
  return out;
}

export async function importJats(opts: ImportJatsOptions): Promise<ImportSummary> {
  const folder = normalizeFolder(opts.folder ?? "nodes/papers") || "nodes/papers";
  const relink = opts.relink !== false;
  const warnings: string[] = [];
  const failed: ImportSummary["failed"] = [];
  const skipped: string[] = [];

  // 1. Convert. Byte-identical inputs collapse to one; two different XMLs for
  //    the same paper keep the last one and say so.
  const bySha = new Set<string>();
  const xmlBySha = new Map<string, string>();
  const byPath = new Map<string, ReturnType<typeof jatsToDocument>>();
  // A file may hold several <article>s (a pmc-articleset dump); each is its
  // own source, named `file#n`, hashed on its own.
  const articles: JatsSource[] = [];
  for (const src of opts.sources) {
    const parts = splitJatsArticles(src.xml);
    if (parts.length === 1) articles.push(src);
    else {
      warnings.push(`${src.name}: ${parts.length} articles in one file — imported individually`);
      parts.forEach((xml, i) => articles.push({ name: `${src.name}#${i + 1}`, xml }));
    }
  }
  for (const src of articles) {
    let r: ReturnType<typeof jatsToDocument>;
    try {
      r = jatsToDocument(src.xml, { sourcePath: src.name, folder });
    } catch (err) {
      failed.push({ title: src.name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const w of r.warnings) warnings.push(`${src.name}: ${w}`);
    if (bySha.has(r.sha256)) {
      skipped.push(`${src.name} (duplicate of an earlier file in this batch)`);
      continue;
    }
    bySha.add(r.sha256);
    xmlBySha.set(r.sha256, src.xml);
    if (byPath.has(r.path)) {
      warnings.push(`${src.name}: same paper as ${byPath.get(r.path)!.meta.title} — later file wins`);
    }
    byPath.set(r.path, r);
  }

  // 2. Skip what the vault already holds at this hash.
  const existing = await existingPapers(opts.storage, folder);
  const existingById = new Map(existing.map((d) => [d.id, d]));
  const fresh: Array<ReturnType<typeof jatsToDocument>> = [];
  for (const r of byPath.values()) {
    const id = r.path.replace(/\.md$/, "");
    const prev = existingById.get(id);
    if (prev && prev.frontmatter.status === "rejected") {
      // Governance wins over ingestion: a retired paper is not resurrected by
      // re-running the import. Change its status first if that is intended.
      skipped.push(`${id} (rejected by a steward — not republished)`);
      continue;
    }
    const prevMeta = prev ? metadataOf(prev) : undefined;
    if (
      !opts.force &&
      prevMeta &&
      prevMeta.source_sha256 === r.sha256 &&
      prevMeta.importer === JATS_IMPORTER_VERSION
    ) {
      skipped.push(`${id} (unchanged)`);
      continue;
    }
    fresh.push(r);
  }

  // 3. Citation graph over existing + incoming.
  const index = buildCitationIndex([
    ...existing.map((d) => ({ id: d.id, metadata: metadataOf(d) })),
    ...fresh.map((r) => ({ id: r.path.replace(/\.md$/, ""), metadata: { doi: r.meta.doi, pmid: r.meta.pmid } })),
  ]);
  const files: Array<{ path: string; content: string }> = [];
  for (const r of fresh) {
    const prev = existingById.get(r.path.replace(/\.md$/, ""));
    let content = r.content;
    // Enrichment already on the node (PubTator entities, mesh tags) survives a
    // re-import: the twin's body and NLM metadata are replaced, the rest kept.
    if (prev) content = carryEnrichment(prev, content);
    const linked = linkCitations(content, index);
    files.push({ path: r.path, content: linked.content });
  }

  // 4. Papers already in the vault may now be able to cite the arrivals.
  const relinked: string[] = [];
  if (relink && fresh.length) {
    const freshIds = new Set(fresh.map((r) => r.path.replace(/\.md$/, "")));
    // Only a paper whose reference list names an arrival can gain an edge;
    // everything else is left unparsed so the pass stays O(arrivals), not
    // O(vault).
    const freshDois = new Set(fresh.map((r) => r.meta.doi?.toLowerCase()).filter(Boolean));
    const freshPmids = new Set(fresh.map((r) => r.meta.pmid).filter(Boolean));
    for (const d of existing) {
      if (freshIds.has(d.id)) continue;
      const refs = metadataOf(d).refs;
      const cites = Array.isArray(refs)
        ? (refs as Array<{ doi?: string; pmid?: string }>).some(
            (ref) => (ref.doi && freshDois.has(ref.doi.toLowerCase())) || (ref.pmid && freshPmids.has(ref.pmid)),
          )
        : false;
      if (!cites) continue;
      const linked = linkCitations(d.rawContent, index);
      if (linked.changed) {
        files.push({ path: `${d.id}.md`, content: linked.content });
        relinked.push(d.id);
      }
    }
  }

  // 5. Originals, when asked for. Written beside the twins, inside the vault,
  //    so a re-import can be audited against exactly what was ingested.
  if (opts.keepXml && fresh.length) {
    const dir = pathMod.join(opts.storage.root, "assets", "jats");
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      fresh.map((r) => fs.writeFile(pathMod.join(dir, `${r.slug}.jats.xml`), xmlBySha.get(r.sha256) ?? "", "utf8")),
    );
  }

  if (files.length === 0) {
    return { published: [], skipped, failed, relinked, checkpoint: null, warnings };
  }

  const result = await publishFiles(opts.api, opts.ctx, files);
  for (const w of result.warnings ?? []) warnings.push(w);
  return {
    published: result.published,
    skipped,
    failed: [...failed, ...result.failed],
    relinked: relinked.filter((id) => result.published.some((p) => p.id === id)),
    checkpoint: result.checkpoint,
    warnings,
  };
}

/**
 * Merge enrichment (PubTator entities/relations, `#mesh-` tags, anything
 * else the import did not author) from the previous twin into the new one.
 */
function carryEnrichment(prev: ContextNode, nextContent: string): string {
  const prevMeta = metadataOf(prev);
  const next = parseDocument("x.md", nextContent, "x");
  const nextMeta = { ...(next.frontmatter.metadata ?? {}) } as Record<string, unknown>;
  for (const key of ["entities", "relations", "pubtator", "pmid", "pmcid"]) {
    if (nextMeta[key] === undefined && prevMeta[key] !== undefined) nextMeta[key] = prevMeta[key];
  }
  const tags = [...(next.frontmatter.tags ?? [])];
  for (const t of prev.frontmatter.tags ?? []) {
    if (t.startsWith("#mesh-") && !tags.includes(t)) tags.push(t);
  }
  return serializeDocument({
    ...next,
    frontmatter: { ...next.frontmatter, tags, metadata: nextMeta },
  });
}

// ─── ctx import pubmed ───────────────────────────────────────────────────────

export interface FetchPubmedOptions extends NcbiOptions {
  term: string;
  max: number;
  onProgress?: (done: number, total: number, pmcid: string) => void;
}

/** Search PMC and fetch each hit's JATS as an import source. */
export async function fetchPmcSources(opts: FetchPubmedOptions): Promise<{ sources: JatsSource[]; total: number; failed: string[] }> {
  const { ids, count } = await esearch("pmc", opts.term, opts.max, opts);
  const sources: JatsSource[] = [];
  const failed: string[] = [];
  let done = 0;
  for (const id of ids) {
    const pmcid = `PMC${id}`;
    try {
      sources.push({ name: pmcid, xml: await efetchPmc(pmcid, opts) });
    } catch (err) {
      failed.push(`${pmcid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    done++;
    opts.onProgress?.(done, ids.length, pmcid);
  }
  return { sources, total: count, failed };
}

// ─── ctx enrich pubtator ─────────────────────────────────────────────────────

export interface EnrichOptions extends NcbiOptions {
  storage: NestStorage;
  api: ApiRunner;
  ctx: OperationContext;
  folder?: string;
  /** Re-fetch papers that already carry `metadata.pubtator`. */
  force?: boolean;
  /** Only these node ids (default: every paper under `folder`). */
  ids?: string[];
  /** Most-mentioned MeSH entities to promote to `#mesh-` tags (default 12). */
  tagLimit?: number;
  onProgress?: (msg: string) => void;
}

export interface EnrichSummary {
  enriched: Array<{ id: string; version: number }>;
  skipped: string[];
  unresolved: string[];
  failed: Array<{ id?: string; title?: string; error: string }>;
  checkpoint: number | null;
  warnings?: string[];
}

export const PUBTATOR_VERSION = "pubtator3/1";

/** Apply one PubTator summary to a twin's frontmatter. Pure. */
export function applyPubTator(
  node: ContextNode,
  summary: PubTatorSummary,
  tagLimit = 12,
): string {
  const meta = { ...metadataOf(node) } as Record<string, unknown>;
  if (!meta.pmid && summary.pmid) meta.pmid = summary.pmid;
  if (!meta.pmcid && summary.pmcid) meta.pmcid = summary.pmcid;
  meta.entities = summary.entities.slice(0, 60).map((e) => ({
    id: e.id,
    type: e.type,
    ...(e.name ? { name: e.name } : {}),
    count: e.count,
  }));
  meta.relations = summary.relations.slice(0, 120);
  meta.pubtator = { version: PUBTATOR_VERSION, scope: summary.scope };

  const tags = (node.frontmatter.tags ?? []).filter((t) => !t.startsWith("#mesh-"));
  let added = 0;
  for (const e of summary.entities) {
    if (added >= tagLimit) break;
    if (!/^(Disease|Chemical)$/i.test(e.type)) continue;
    const t = meshTag(e);
    if (t && !tags.includes(t)) {
      tags.push(t);
      added++;
    }
  }
  return serializeDocument({ ...node, frontmatter: { ...node.frontmatter, tags, metadata: meta } });
}

export async function enrichPubTator(opts: EnrichOptions): Promise<EnrichSummary> {
  const folder = normalizeFolder(opts.folder ?? "nodes/papers") || "nodes/papers";
  let papers = await existingPapers(opts.storage, folder);
  const unknown: string[] = [];
  if (opts.ids?.length) {
    // `pmid-123`, `papers/pmid-123`, `nodes/papers/pmid-123` and `….md` all
    // name the same twin; an id that names nothing is reported, not ignored.
    const byId = new Map(papers.map((p) => [p.id, p]));
    const chosen: ContextNode[] = [];
    for (const raw of opts.ids) {
      const bare = raw.replace(/\.md$/, "").replace(/^\/+/, "");
      const candidates = [bare, `${folder}/${bare}`, `${folder}/${bare.replace(/^nodes\//, "")}`, `nodes/${bare}`];
      const hit = candidates.map((c) => byId.get(c)).find(Boolean);
      if (hit) {
        if (!chosen.includes(hit)) chosen.push(hit);
      } else unknown.push(raw);
    }
    papers = chosen;
  }
  const skipped: string[] = [];
  const unresolved: string[] = [];
  const failed: EnrichSummary["failed"] = unknown.map((id) => ({ id, error: `no paper with this id under ${folder}` }));

  // 1. Every paper needs a PMID; resolve from DOI / PMCID when the XML had none.
  const byPmid = new Map<string, ContextNode>();
  for (const p of papers) {
    const meta = metadataOf(p);
    if (!opts.force && meta.pubtator) {
      skipped.push(`${p.id} (already enriched)`);
      continue;
    }
    let pmid = typeof meta.pmid === "string" ? meta.pmid : undefined;
    if (!pmid) {
      const doi = typeof meta.doi === "string" ? meta.doi : undefined;
      const pmcid = typeof meta.pmcid === "string" ? meta.pmcid : undefined;
      if (doi || pmcid) {
        try {
          pmid = await resolvePmid({ doi, pmcid }, opts);
        } catch (err) {
          failed.push({ id: p.id, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
      }
    }
    if (!pmid) {
      unresolved.push(`${p.id} (no PMID — PubMed has no record for its DOI/PMCID)`);
      continue;
    }
    opts.onProgress?.(`${p.id} → PMID ${pmid}`);
    const clash = byPmid.get(pmid);
    if (clash) {
      // Two nodes resolving to one PMID is a metadata problem to surface,
      // not a paper to silently drop on the floor.
      failed.push({ id: p.id, error: `resolves to PMID ${pmid}, already claimed by ${clash.id} in this batch` });
      continue;
    }
    byPmid.set(pmid, p);
  }

  // 2. Fetch in batches of 100, apply, republish as one batch.
  const files: Array<{ path: string; content: string }> = [];
  if (byPmid.size) {
    let summaries: Map<string, PubTatorSummary>;
    try {
      summaries = await pubtatorFetch([...byPmid.keys()], opts);
    } catch (err) {
      return {
        enriched: [],
        skipped,
        unresolved,
        failed: [...failed, { error: err instanceof Error ? err.message : String(err) }],
        checkpoint: null,
      };
    }
    for (const [pmid, node] of byPmid) {
      const s = summaries.get(pmid);
      if (!s) {
        unresolved.push(`${node.id} (PubTator has no record for PMID ${pmid})`);
        continue;
      }
      files.push({ path: `${node.id}.md`, content: applyPubTator(node, s, opts.tagLimit) });
    }
  }
  if (files.length === 0) return { enriched: [], skipped, unresolved, failed, checkpoint: null };

  const result = await publishFiles(opts.api, opts.ctx, files);
  return {
    enriched: result.published,
    skipped,
    unresolved,
    failed: [...failed, ...result.failed],
    checkpoint: result.checkpoint,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}
