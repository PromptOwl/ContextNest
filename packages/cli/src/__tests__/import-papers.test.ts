import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
} from "@promptowl/contextnest-engine";
import { createEngineApi, type OperationContext } from "@promptowl/contextnest-engine/api";
import {
  importJats,
  enrichPubTator,
  applyPubTator,
  applyPublicationTypes,
  fetchPmcSources,
  pubmedTerm,
  PUBTATOR_VERSION,
} from "../import-papers.js";

// CU-wdqcq02c6w: `ctx import jats` / `ctx enrich pubtator` against a real
// throwaway vault, engine in-process, network replaced by an injected fetch.

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(
  join(here, "..", "..", "..", "engine", "src", "__tests__", "fixtures", "jats-sample.xml"),
  "utf8",
);
const bioc = readFileSync(join(here, "fixtures", "pubtator-30056182.json"), "utf8");

/** A second paper that the fixture's reference #1 cites (same DOI). */
const citedXml = xml
  .replace('<article-id pub-id-type="pmid">99900001</article-id>', "")
  .replace('<article-id pub-id-type="pmc">PMC9990001</article-id>', "")
  .replace("10.9999/jsg.2024.001", "10.1016/j.cgh.2018.07.026")
  .replace("A Synthetic Trial", "The Cited Review");

let dir: string;
let storage: NestStorage;
let ctx: OperationContext;
const api = createEngineApi();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cn-import-papers-"));
  storage = new NestStorage(dir);
  await storage.init("papers");
  ctx = {
    storage,
    query: new GraphQueryEngine(storage),
    versions: new VersionManager(storage),
    actor: "tester@example.com",
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("importJats", () => {
  it("publishes twins in one checkpoint, dedupes byte-identical files, and skips unchanged re-runs", async () => {
    const first = await importJats({
      storage,
      api,
      ctx,
      sources: [
        { name: "a.xml", xml },
        { name: "a-copy.xml", xml },
      ],
    });
    expect(first.published.map((p) => p.id)).toEqual(["nodes/papers/pmid-99900001"]);
    expect(first.skipped).toEqual(["a-copy.xml (duplicate of an earlier file in this batch)"]);
    expect(first.checkpoint).not.toBeNull();
    expect(first.failed).toEqual([]);

    const docs = await storage.discoverDocuments();
    const paper = docs.find((d) => d.id === "nodes/papers/pmid-99900001")!;
    expect(paper.frontmatter.status).toBe("published");
    expect(paper.frontmatter.tags).toContain("#pubtype-srma");
    expect(paper.body).toContain("^p_1_1");

    const second = await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }] });
    expect(second.published).toEqual([]);
    expect(second.skipped).toEqual(["nodes/papers/pmid-99900001 (unchanged)"]);
    expect(second.checkpoint).toBeNull();

    const forced = await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }], force: true });
    expect(forced.published).toEqual([{ id: "nodes/papers/pmid-99900001", version: 2 }]);
  });

  it("links citations across the batch and re-links earlier papers when a cited one arrives", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }] });
    let a = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-99900001")!;
    expect(a.body).not.toContain("→ [[");

    const r = await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    expect(r.published.map((p) => p.id).sort()).toEqual([
      "nodes/papers/doi-10-1016-j-cgh-2018-07-026",
      "nodes/papers/pmid-99900001",
    ]);
    expect(r.relinked).toEqual(["nodes/papers/pmid-99900001"]);

    a = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-99900001")!;
    expect(a.body).toContain("doi:10.1016/j.cgh.2018.07.026 → [[nodes/papers/doi-10-1016-j-cgh-2018-07-026]]");
    expect((a.frontmatter.metadata as { cites: string[] }).cites).toEqual([
      "nodes/papers/doi-10-1016-j-cgh-2018-07-026",
    ]);
    expect(a.frontmatter.version).toBe(2);

    // Nothing left to re-link: a third run is a no-op.
    const again = await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    expect(again.published).toEqual([]);
  });

  it("imports every article of a pmc-articleset file and says so", async () => {
    const strip = (x: string) => x.replace(/^<\?xml[^>]*>\s*/, "");
    const set = `<pmc-articleset>${strip(xml)}${strip(citedXml)}</pmc-articleset>`;
    const r = await importJats({ storage, api, ctx, sources: [{ name: "set.xml", xml: set }] });
    expect(r.published.map((p) => p.id).sort()).toEqual([
      "nodes/papers/doi-10-1016-j-cgh-2018-07-026",
      "nodes/papers/pmid-99900001",
    ]);
    expect(r.warnings).toContain("set.xml: 2 articles in one file — imported individually");
    const a = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-99900001")!;
    expect((a.frontmatter.metadata as { source_path: string }).source_path).toBe("set.xml#1");
    // Cross-article citation inside one file is linked in the same batch.
    expect(a.body).toContain("→ [[nodes/papers/doi-10-1016-j-cgh-2018-07-026]]");
  });

  it("does not resurrect a paper a steward rejected", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }] });
    const id = "nodes/papers/pmid-99900001";
    const doc = (await storage.discoverDocuments()).find((d) => d.id === id)!;
    await storage.writeDocument(id, doc.rawContent.replace("status: published", "status: rejected"));

    const r = await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }], force: true });
    expect(r.published).toEqual([]);
    expect(r.skipped).toEqual([`${id} (rejected by a steward — not republished)`]);
    const after = (await storage.discoverDocuments({ includeRetired: true })).find((d) => d.id === id)!;
    expect(after.frontmatter.status).toBe("rejected");
  });

  it("does not relink a rejected paper when a paper it cites arrives", async () => {
    // context_import writes staged files before publish refuses a rejected id,
    // so the relink pass must not stage one at all.
    await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }] });
    const id = "nodes/papers/pmid-99900001";
    const doc = (await storage.discoverDocuments()).find((d) => d.id === id)!;
    const rejected = doc.rawContent.replace("status: published", "status: rejected");
    await storage.writeDocument(id, rejected);

    const r = await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    expect(r.relinked).toEqual([]);
    expect(r.failed).toEqual([]);
    const after = (await storage.discoverDocuments({ includeRetired: true })).find((d) => d.id === id)!;
    expect(after.rawContent).toBe(rejected);
  });

  it("reports a malformed file without aborting the batch", async () => {
    const r = await importJats({
      storage,
      api,
      ctx,
      sources: [
        { name: "bad.xml", xml: "<not-jats/>" },
        { name: "a.xml", xml },
      ],
    });
    expect(r.failed).toEqual([{ title: "bad.xml", error: expect.stringMatching(/no <article>/) }]);
    expect(r.published).toHaveLength(1);
  });

  it("stores the original XML under assets/jats when asked", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }], keepXml: true });
    const kept = join(dir, "assets", "jats", "pmid-99900001.jats.xml");
    expect((await stat(kept)).isFile()).toBe(true);
    expect(await readFile(kept, "utf8")).toBe(xml);
  });

  it("honours a custom folder", async () => {
    const r = await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }], folder: "nodes/lit" });
    expect(r.published[0].id).toBe("nodes/lit/pmid-99900001");
  });
});

describe("enrichPubTator", () => {
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (/esearch\.fcgi/.test(url)) {
      return new Response(JSON.stringify({ esearchresult: { idlist: ["30056182"] } }), { status: 200 });
    }
    if (/esummary\.fcgi/.test(url)) {
      return new Response(
        JSON.stringify({ result: { uids: ["30056182"], "30056182": { pubtype: ["Journal Article", "Systematic Review", "Meta-Analysis"], articleids: [] } } }),
        { status: 200 },
      );
    }
    if (/pubtator3-api/.test(url)) {
      expect(url).toContain("pmids=30056182");
      return new Response(bioc, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  it("resolves a missing PMID from the DOI, merges entities/relations/mesh tags, and is idempotent", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    const r = await enrichPubTator({ storage, api, ctx, fetchImpl, minIntervalMs: 0 });
    expect(r.enriched).toEqual([{ id: "nodes/papers/doi-10-1016-j-cgh-2018-07-026", version: 2 }]);
    expect(r.unresolved).toEqual([]);

    const doc = (await storage.discoverDocuments()).find(
      (d) => d.id === "nodes/papers/doi-10-1016-j-cgh-2018-07-026",
    )!;
    const meta = doc.frontmatter.metadata as Record<string, unknown>;
    expect(meta.pmid).toBe("30056182");
    expect(meta.pubtator).toEqual({ version: PUBTATOR_VERSION, scope: "abstract" });
    expect((meta.entities as unknown[]).length).toBeGreaterThan(0);
    expect(doc.frontmatter.tags).toContain("#mesh-d015179");
    // MEDLINE publication types, not the JATS article-type, drive #pubtype-*.
    expect(meta.publication_types).toEqual(["Journal Article", "Systematic Review", "Meta-Analysis"]);
    expect(doc.frontmatter.tags).toEqual(
      expect.arrayContaining(["#pubtype-systematic-review", "#pubtype-meta-analysis", "#pubtype-srma", "#article-type-research-article"]),
    );
    expect(doc.frontmatter.tags).not.toContain("#pubtype-research-article");
    // The twin's body is untouched by enrichment.
    expect(doc.body).toContain("^p_1_1");

    const again = await enrichPubTator({ storage, api, ctx, fetchImpl, minIntervalMs: 0 });
    expect(again.enriched).toEqual([]);
    expect(again.skipped).toEqual(["nodes/papers/doi-10-1016-j-cgh-2018-07-026 (already enriched)"]);
  });

  it("keeps enrichment through a forced re-import of the same paper", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    await enrichPubTator({ storage, api, ctx, fetchImpl, minIntervalMs: 0 });
    await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }], force: true });
    const doc = (await storage.discoverDocuments()).find(
      (d) => d.id === "nodes/papers/doi-10-1016-j-cgh-2018-07-026",
    )!;
    expect(doc.frontmatter.tags).toContain("#mesh-d015179");
    expect(doc.frontmatter.tags).toContain("#pubtype-srma");
    expect(doc.frontmatter.tags).not.toContain("#pubtype-research-article");
    expect((doc.frontmatter.metadata as Record<string, unknown>).pmid).toBe("30056182");
    expect((doc.frontmatter.metadata as Record<string, unknown>).publication_types).toHaveLength(3);
    expect(doc.frontmatter.version).toBe(3);
  });

  it("accepts a short id and reports an unknown one", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    const r = await enrichPubTator({
      storage, api, ctx, fetchImpl, minIntervalMs: 0,
      ids: ["doi-10-1016-j-cgh-2018-07-026", "nope-123"],
    });
    expect(r.enriched.map((e) => e.id)).toEqual(["nodes/papers/doi-10-1016-j-cgh-2018-07-026"]);
    expect(r.failed).toEqual([{ id: "nope-123", error: "no paper with this id under nodes/papers" }]);
  });

  it("reports a PMID collision instead of silently dropping the second paper", async () => {
    // Two distinct papers (different DOIs) whose DOIs both resolve to one PMID.
    const other = citedXml.replace("10.1016/j.cgh.2018.07.026", "10.1016/j.cgh.2018.07.099");
    await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml: citedXml }, { name: "b.xml", xml: other }] });
    const r = await enrichPubTator({ storage, api, ctx, fetchImpl, minIntervalMs: 0 });
    expect(r.enriched).toHaveLength(1);
    expect(r.failed).toEqual([
      { id: expect.stringMatching(/^nodes\/papers\/doi-/), error: expect.stringMatching(/already claimed by nodes\/papers\/doi-/) },
    ]);
  });

  it("leaves a rejected paper untouched", async () => {
    await importJats({ storage, api, ctx, sources: [{ name: "cited.xml", xml: citedXml }] });
    const id = "nodes/papers/doi-10-1016-j-cgh-2018-07-026";
    const doc = (await storage.discoverDocuments()).find((d) => d.id === id)!;
    const rejected = doc.rawContent.replace("status: published", "status: rejected");
    await storage.writeDocument(id, rejected);

    const r = await enrichPubTator({ storage, api, ctx, fetchImpl, minIntervalMs: 0 });
    expect(r.enriched).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([`${id} (rejected by a steward)`]);
    const after = (await storage.discoverDocuments({ includeRetired: true })).find((d) => d.id === id)!;
    expect(after.rawContent).toBe(rejected);
  });

  it("reports papers with no resolvable PMID instead of failing", async () => {
    const noIds = xml
      .replace('<article-id pub-id-type="pmid">99900001</article-id>', "")
      .replace('<article-id pub-id-type="pmc">PMC9990001</article-id>', "")
      .replace('<article-id pub-id-type="doi">10.9999/jsg.2024.001</article-id>', "");
    await importJats({ storage, api, ctx, sources: [{ name: "x.xml", xml: noIds }] });
    const r = await enrichPubTator({ storage, api, ctx, fetchImpl, minIntervalMs: 0 });
    expect(r.enriched).toEqual([]);
    expect(r.unresolved).toHaveLength(1);
  });
});

describe("applyPubTator", () => {
  it("caps mesh tags at tagLimit and only promotes diseases/chemicals", () => {
    const node = {
      id: "nodes/papers/pmid-1",
      filePath: "/v/nodes/papers/pmid-1.md",
      frontmatter: { title: "T", type: "reference" as const, tags: ["#paper", "#mesh-stale"] },
      body: "# T\n",
      rawContent: "",
    };
    const out = applyPubTator(
      node,
      {
        pmid: "1",
        scope: "abstract",
        relations: [],
        entities: [
          { id: "MESH:D000001", type: "Disease", count: 5 },
          { id: "NCBIGene:7124", type: "Gene", count: 4 },
          { id: "MESH:D000002", type: "Chemical", count: 3 },
          { id: "MESH:D000003", type: "Disease", count: 2 },
        ],
      },
      2,
    );
    expect(out).toContain("'#mesh-d000001'");
    expect(out).toContain("'#mesh-d000002'");
    expect(out).not.toContain("d000003");
    expect(out).not.toContain("#mesh-stale");
  });
});

// ─── ctx import pubmed: PubMed search, PMC mapping, licence filter, pubtypes ──

/** The fixture as a plain research article (no AGA document_type envelope). */
const plainXml = xml.replace(/<custom-meta-group>[\s\S]*?<\/custom-meta-group>/, "");
const CC_BY = '<license license-type="open-access" xlink:href="http://creativecommons.org/licenses/by/4.0/">';

function article(pmid: string, license: "cc-by" | "cc-by-nc" | "none"): string {
  let x = plainXml
    .replace("<article-id pub-id-type=\"pmid\">99900001</article-id>", `<article-id pub-id-type="pmid">${pmid}</article-id>`)
    .replace("10.9999/jsg.2024.001", `10.9999/jsg.${pmid}`);
  if (license === "cc-by-nc") x = x.replace(CC_BY, '<license xlink:href="https://creativecommons.org/licenses/by-nc/4.0/">');
  if (license === "none") x = x.replace(/<license[\s\S]*?<\/license>/, "");
  return `<pmc-articleset>${x.replace(/^<\?xml[^>]*>/, "")}</pmc-articleset>`;
}

/**
 * A fake NCBI: PubMed returns six PMIDs; 1004 has no PMC full text; PMC's
 * licence filter says 2003 is not CC BY/CC0; the JATS of 2002 declares no
 * licence and 2006 declares CC BY-NC (the filter missed it — JATS decides).
 */
function ncbi(): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const pubtypes: Record<string, string[]> = {
    "1001": ["Journal Article", "Systematic Review", "Meta-Analysis"],
    "1002": ["Journal Article", "Review"],
    "1003": ["Journal Article"],
    "1004": ["Journal Article"],
    "1005": ["Practice Guideline"],
    "1006": ["Randomized Controlled Trial"],
  };
  const jats: Record<string, string> = {
    "2001": article("1001", "cc-by"),
    "2002": article("1002", "none"),
    "2003": article("1003", "cc-by-nc"),
    "2005": article("1005", "cc-by"),
    "2006": article("1006", "cc-by-nc"),
  };
  const f = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith("/esearch.fcgi") && u.searchParams.get("db") === "pubmed") {
      return json({ esearchresult: { idlist: ["1001", "1002", "1003", "1004", "1006", "1005"], count: "6" } });
    }
    if (u.pathname.endsWith("/esearch.fcgi") && u.searchParams.get("db") === "pmc") {
      const term = u.searchParams.get("term") ?? "";
      const uids = [...term.matchAll(/(\d+)\[uid\]/g)].map((m) => m[1]);
      return json({ esearchresult: { idlist: uids.filter((id) => id !== "2003"), count: "0" } });
    }
    if (u.pathname.endsWith("/esummary.fcgi")) {
      const ids = (u.searchParams.get("id") ?? "").split(",");
      const result: Record<string, unknown> = { uids: ids };
      for (const id of ids) {
        result[id] = {
          pubtype: pubtypes[id] ?? [],
          articleids: id === "1004" ? [] : [{ idtype: "pmc", value: `PMC${Number(id) + 1000}` }],
        };
      }
      return json({ result });
    }
    if (u.pathname.endsWith("/efetch.fcgi")) {
      const body = jats[u.searchParams.get("id") ?? ""];
      return body ? new Response(body, { status: 200 }) : new Response("<error/>", { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("fetchPmcSources (ctx import pubmed)", () => {
  it("searches db=pubmed restricted to PMC full text, not db=pmc", () => {
    expect(pubmedTerm("chronic pain[mh] AND systematic review[pt]")).toBe(
      '(chronic pain[mh] AND systematic review[pt]) AND "pubmed pmc"[sb]',
    );
    expect(pubmedTerm('fmt AND "pubmed pmc"[sb]')).toBe('fmt AND "pubmed pmc"[sb]');
  });

  it("maps PMIDs to PMCIDs, drops non-matching licences (filter + JATS), and fills --max after filtering", async () => {
    const fetchImpl = ncbi();
    const r = await fetchPmcSources({ term: "x[mh]", max: 2, licenses: ["cc-by", "cc0"], fetchImpl, minIntervalMs: 0 });
    expect(r.sources.map((s) => s.name)).toEqual(["PMC2001", "PMC2005"]);
    expect(r.sources[0].publicationTypes).toEqual(["Journal Article", "Systematic Review", "Meta-Analysis"]);
    expect(r.total).toBe(6);
    expect(r.skippedLicense).toEqual([
      "PMC2002 (PMID 1002): licence none declared",
      "PMC2003 (PMID 1003): licence not in cc-by,cc0 (PMC filter)",
      "PMC2006 (PMID 1006): licence cc-by-nc",
    ]);
    expect(r.failed).toEqual(["PMID 1004: no PMC full text linked"]);

    const search = new URL(fetchImpl.calls[0]);
    expect(search.searchParams.get("db")).toBe("pubmed");
    expect(search.searchParams.get("term")).toBe('(x[mh]) AND "pubmed pmc"[sb]');
    // Over-fetch candidates (6× max) so licence drops do not shrink the batch.
    expect(search.searchParams.get("retmax")).toBe("12");
    // The PMC-filtered article is never downloaded.
    expect(fetchImpl.calls.some((c) => c.includes("efetch") && c.includes("id=2003"))).toBe(false);
  });

  it("without --license keeps every licence and stops at --max", async () => {
    const fetchImpl = ncbi();
    const r = await fetchPmcSources({ term: "x", max: 2, fetchImpl, minIntervalMs: 0 });
    expect(r.sources.map((s) => s.name)).toEqual(["PMC2001", "PMC2002"]);
    expect(r.skippedLicense).toEqual([]);
    expect(fetchImpl.calls.filter((c) => c.includes("efetch"))).toHaveLength(2);
    expect(fetchImpl.calls.some((c) => c.includes("db=pmc") && c.includes("esearch"))).toBe(false);
  });

  it("imports with MEDLINE #pubtype-* tags, keeps the JATS article-type separately, and is idempotent", async () => {
    const fetchImpl = ncbi();
    const fetched = await fetchPmcSources({ term: "x", max: 6, licenses: ["cc-by"], fetchImpl, minIntervalMs: 0 });
    const first = await importJats({ storage, api, ctx, sources: fetched.sources });
    expect(first.published.map((p) => p.id).sort()).toEqual(["nodes/papers/pmid-1001", "nodes/papers/pmid-1005"]);

    const docs = await storage.discoverDocuments();
    const sr = docs.find((d) => d.id === "nodes/papers/pmid-1001")!;
    expect(sr.frontmatter.tags).toEqual(
      expect.arrayContaining(["#pubtype-systematic-review", "#pubtype-meta-analysis", "#pubtype-srma", "#article-type-research-article", "#license-cc-by"]),
    );
    expect(sr.frontmatter.tags).not.toContain("#pubtype-research-article");
    const meta = sr.frontmatter.metadata as Record<string, unknown>;
    expect(meta.publication_types).toEqual(["Journal Article", "Systematic Review", "Meta-Analysis"]);
    expect(meta.article_type).toBe("research-article");
    const gl = docs.find((d) => d.id === "nodes/papers/pmid-1005")!;
    expect(gl.frontmatter.tags).toContain("#pubtype-guideline");
    expect(gl.frontmatter.tags).not.toContain("#pubtype-srma");

    // Same XML, same types → nothing to do.
    const again = await importJats({ storage, api, ctx, sources: fetched.sources });
    expect(again.published).toEqual([]);
    expect(again.skipped).toHaveLength(2);

    // A plain JATS re-import (types unknown) keeps the PubMed-derived tags.
    const plain = fetched.sources.map(({ name, xml: x }) => ({ name, xml: x }));
    const forced = await importJats({ storage, api, ctx, sources: plain, force: true });
    expect(forced.published).toHaveLength(2);
    const sr2 = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-1001")!;
    expect(sr2.frontmatter.tags).toEqual(sr.frontmatter.tags);
    expect((sr2.frontmatter.metadata as Record<string, unknown>).publication_types).toEqual(meta.publication_types);
  });

  it("republishes an unchanged twin once its publication types become known", async () => {
    const src = { name: "PMC2001", xml: article("1001", "cc-by") };
    await importJats({ storage, api, ctx, sources: [src] });
    let doc = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-1001")!;
    expect(doc.frontmatter.tags).toContain("#pubtype-research-article");
    const r = await importJats({ storage, api, ctx, sources: [{ ...src, publicationTypes: ["Review"] }] });
    expect(r.published).toEqual([{ id: "nodes/papers/pmid-1001", version: 2 }]);
    doc = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-1001")!;
    expect(doc.frontmatter.tags).toContain("#pubtype-review");
    expect(doc.frontmatter.tags).not.toContain("#pubtype-research-article");
  });
});

describe("applyPublicationTypes", () => {
  it("is idempotent and keeps the publisher's document_type pubtype tag", async () => {
    const r = await importJats({ storage, api, ctx, sources: [{ name: "a.xml", xml }] });
    expect(r.published).toHaveLength(1);
    const doc = (await storage.discoverDocuments()).find((d) => d.id === "nodes/papers/pmid-99900001")!;
    const once = applyPublicationTypes(doc.rawContent, ["Randomized Controlled Trial"]);
    expect(applyPublicationTypes(once, ["Randomized Controlled Trial"])).toBe(once);
    expect(once).toContain("'#pubtype-rct'");
    // AGA's custom-meta document_type (SRMA) is curated upstream: kept.
    expect(once).toContain("'#pubtype-srma'");
    expect(once).not.toContain("'#pubtype-research-article'");
    expect(once).toContain("'#article-type-research-article'");
  });
});
