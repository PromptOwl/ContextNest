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
import { importJats, enrichPubTator, applyPubTator, PUBTATOR_VERSION } from "../import-papers.js";

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
    expect((doc.frontmatter.metadata as Record<string, unknown>).pmid).toBe("30056182");
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
