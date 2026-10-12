import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  esearch,
  esummaryPubmed,
  meshTag,
  parseLicenseList,
  pmcLicensePrefilter,
  publicationTypeTags,
  pubtatorFetch,
  resolvePmid,
  summarizePubTator,
} from "../pubmed.js";

const here = dirname(fileURLToPath(import.meta.url));
const biocText = readFileSync(join(here, "fixtures", "pubtator-30056182.json"), "utf8");
const bioc = JSON.parse(biocText) as { PubTator3: Array<Record<string, unknown>> };

function fakeFetch(routes: Array<[RegExp, string | { status: number; body?: string }]>): typeof fetch {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    for (const [re, resp] of routes) {
      if (!re.test(url)) continue;
      if (typeof resp === "string") return new Response(resp, { status: 200 });
      return new Response(resp.body ?? "", { status: resp.status });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  (f as unknown as { calls: string[] }).calls = calls;
  return f;
}

describe("summarizePubTator", () => {
  it("reduces a real BioC document to counted, normalised entities", () => {
    const s = summarizePubTator(bioc.PubTator3[0]);
    expect(s.pmid).toBe("30056182");
    expect(s.scope).toBe("abstract");
    expect(s.entities.length).toBeGreaterThan(3);
    const crc = s.entities.find((e) => e.id === "MESH:D015179");
    expect(crc).toMatchObject({ type: "Disease", name: "Colorectal Neoplasms" });
    expect(crc!.count).toBeGreaterThanOrEqual(1);
    // Sorted by mention count, descending.
    for (let i = 1; i < s.entities.length; i++) {
      expect(s.entities[i - 1].count).toBeGreaterThanOrEqual(s.entities[i].count);
    }
  });

  it("collects relations from the document and passages, both role encodings, deduplicated", () => {
    const doc = {
      pmid: "1",
      passages: [
        {
          infons: { section_type: "INTRO" },
          annotations: [],
          relations: [
            { infons: { type: "Treat", role1: "Chemical|MESH:D000069471", role2: "Disease|MESH:D003015", score: "0.9" } },
          ],
        },
      ],
      relations: [
        { infons: { type: "treat", role1: { identifier: "MESH:D000069471" }, role2: { identifier: "MESH:D003015" } } },
        { infons: { type: "associate", role1: { identifier: "NCBIGene:7124" }, role2: { identifier: "MESH:D003015" } } },
      ],
    };
    const s = summarizePubTator(doc);
    expect(s.scope).toBe("fulltext");
    expect(s.relations).toEqual([
      { type: "treat", subject: "MESH:D000069471", object: "MESH:D003015", score: 0.9 },
      { type: "associate", subject: "NCBIGene:7124", object: "MESH:D003015" },
    ]);
  });
});

describe("meshTag", () => {
  it("tags only MeSH-normalised entities", () => {
    expect(meshTag({ id: "MESH:D003015", type: "Disease", count: 1 })).toBe("#mesh-d003015");
    expect(meshTag({ id: "NCBIGene:7124", type: "Gene", count: 1 })).toBeUndefined();
    expect(meshTag({ id: "9606", type: "Species", count: 1 })).toBeUndefined();
  });
});

describe("NCBI clients (fetch injected)", () => {
  it("esearch returns ids and count", async () => {
    const fetchImpl = fakeFetch([
      [/esearch\.fcgi\?.*db=pmc/, JSON.stringify({ esearchresult: { idlist: ["1", "2"], count: "89" } })],
    ]);
    const r = await esearch("pmc", "fmt", 2, { fetchImpl, minIntervalMs: 0 });
    expect(r).toEqual({ ids: ["1", "2"], count: 89 });
    const url = (fetchImpl as unknown as { calls: string[] }).calls[0];
    expect(url).toContain("term=fmt");
    expect(url).toContain("retmax=2");
    expect(url).toContain("tool=contextnest");
  });

  it("resolvePmid tries PMCID then DOI and returns the first hit", async () => {
    const fetchImpl = fakeFetch([
      [/%5Bpmcid%5D/, JSON.stringify({ esearchresult: { idlist: [] } })],
      [/%5Bdoi%5D/, JSON.stringify({ esearchresult: { idlist: ["30055267"] } })],
    ]);
    const pmid = await resolvePmid({ pmcid: "PMC9", doi: "10.1016/j.cgh.2018.07.026" }, { fetchImpl, minIntervalMs: 0 });
    expect(pmid).toBe("30055267");
    expect((fetchImpl as unknown as { calls: string[] }).calls).toHaveLength(2);
  });

  it("pubtatorFetch accepts the envelope form and retries on 429", async () => {
    let first = true;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (first) {
        first = false;
        return new Response("rate limit", { status: 429 });
      }
      expect(url).toContain("pmids=30056182");
      return new Response(biocText, { status: 200 });
    }) as unknown as typeof fetch;
    const map = await pubtatorFetch(["30056182"], { fetchImpl, minIntervalMs: 0 });
    expect(map.get("30056182")?.entities.length).toBeGreaterThan(0);
  });

  it("pubtatorFetch only sends digit PMIDs, encoded through URLSearchParams", async () => {
    const fetchImpl = fakeFetch([[/pubtator3-api/, "[]"]]);
    await pubtatorFetch(["30056182", "12&evil=1", "abc", "30056182"], { fetchImpl, minIntervalMs: 0 });
    const calls = (fetchImpl as unknown as { calls: string[] }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/biocjson\?pmids=30056182$/);
  });

  it("pubtatorFetch accepts one-JSON-document-per-line output", async () => {
    const doc = JSON.stringify({ pmid: "5", passages: [{ infons: {}, annotations: [{ infons: { identifier: "MESH:D1", type: "Disease" }, text: "x" }] }] });
    const fetchImpl = fakeFetch([[/pubtator3-api/, `${doc}\n${doc.replace('"pmid":"5"', '"pmid":"6"')}\n`]]);
    const map = await pubtatorFetch(["5", "6"], { fetchImpl, minIntervalMs: 0 });
    expect([...map.keys()].sort()).toEqual(["5", "6"]);
    expect(map.get("5")?.entities[0]).toEqual({ id: "MESH:D1", type: "Disease", count: 1 });
  });

  it("pubtatorFetch reads a 400 as 'no record for any PMID in the batch', not a failure", async () => {
    // Live behaviour: a batch of PMIDs PubTator has not annotated yet (fresh
    // papers) answers 400 {"detail":"Could not retrieve publications"}.
    const fetchImpl = (async () =>
      new Response('{"detail":"Could not retrieve publications"}', { status: 400 })) as unknown as typeof fetch;
    const map = await pubtatorFetch(["42769844"], { fetchImpl, minIntervalMs: 0 });
    expect(map.size).toBe(0);
  });
});

describe("esummaryPubmed", () => {
  it("maps PMIDs to PMC ids and MEDLINE publication types, skipping unknown records", async () => {
    const fetchImpl = fakeFetch([
      [
        /esummary\.fcgi\?.*db=pubmed/,
        JSON.stringify({
          result: {
            uids: ["11", "12", "13"],
            "11": {
              pubtype: ["Journal Article", "Systematic Review", "Meta-Analysis"],
              articleids: [{ idtype: "pubmed", value: "11" }, { idtype: "pmc", value: "PMC111" }],
            },
            "12": { pubtype: ["Review"], articleids: [{ idtype: "doi", value: "10.1/x" }] },
            "13": { error: "cannot get document summary" },
          },
        }),
      ],
    ]);
    const map = await esummaryPubmed(["11", "12", "13", "nope"], { fetchImpl, minIntervalMs: 0 });
    expect(map.get("11")).toEqual({ pmid: "11", pmcid: "PMC111", pubtypes: ["Journal Article", "Systematic Review", "Meta-Analysis"] });
    expect(map.get("12")).toEqual({ pmid: "12", pubtypes: ["Review"] });
    expect(map.has("13")).toBe(false);
    const calls = (fetchImpl as unknown as { calls: string[] }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("id=11%2C12%2C13");
  });
});

describe("publicationTypeTags", () => {
  it("tags SR + MA as srma, and maps guidelines, RCTs and reviews", () => {
    expect(publicationTypeTags(["Journal Article", "Systematic Review", "Meta-Analysis"])).toEqual([
      "#pubtype-systematic-review",
      "#pubtype-meta-analysis",
      "#pubtype-srma",
    ]);
    expect(publicationTypeTags(["Network Meta-Analysis", "Systematic Review"])).toContain("#pubtype-srma");
    expect(publicationTypeTags(["Systematic Review"])).toEqual(["#pubtype-systematic-review"]);
    expect(publicationTypeTags(["Practice Guideline", "Guideline"])).toEqual(["#pubtype-guideline", "#pubtype-practice-guideline"]);
    expect(publicationTypeTags(["Randomized Controlled Trial"])).toEqual(["#pubtype-rct"]);
    expect(publicationTypeTags(["Review"])).toEqual(["#pubtype-review"]);
    // Bibliographic / funding types are metadata, not tags.
    expect(publicationTypeTags(["Journal Article", "Research Support, Non-U.S. Gov't"])).toEqual([]);
    // Selector lexer rejects ':' — every tag must be colon-free.
    for (const t of publicationTypeTags(["Consensus Development Conference, NIH", "Clinical Trial, Phase III"])) {
      expect(t).toMatch(/^#[a-z][a-z0-9-]*$/);
    }
  });
});

describe("parseLicenseList", () => {
  it("normalises spellings and expands commercial", () => {
    expect(parseLicenseList("CC BY 4.0, cc0")).toEqual(["cc-by", "cc0"]);
    expect(parseLicenseList("license-cc-by-nc")).toEqual(["cc-by-nc"]);
    expect(parseLicenseList("commercial")).toEqual(["cc-by", "cc0", "cc-mark", "public-domain"]);
    expect(parseLicenseList("pd")).toEqual(["cc-mark", "public-domain"]);
    expect(() => parseLicenseList(" , ")).toThrow(/no licence/);
  });
});

describe("pmcLicensePrefilter", () => {
  it("runs a positive [uid] + [filter] query when every licence has a PMC filter", async () => {
    const fetchImpl = fakeFetch([[/esearch\.fcgi/, JSON.stringify({ esearchresult: { idlist: ["2"], count: "1" } })]]);
    const keep = await pmcLicensePrefilter(["PMC1", "PMC2"], ["cc-by", "cc0"], { fetchImpl, minIntervalMs: 0 });
    expect([...keep]).toEqual(["2"]);
    const url = decodeURIComponent((fetchImpl as unknown as { calls: string[] }).calls[0]).replace(/\+/g, " ");
    expect(url).toContain("db=pmc");
    // PMC123[pmcid] matches nothing in db=pmc; the numeric uid is what works.
    expect(url).toContain('(1[uid] OR 2[uid]) AND ("cc by license"[filter] OR "cc0 license"[filter])');
    expect(url).not.toContain("[pmcid]");
  });

  it("falls back to dropping known other licences when one has no filter (public domain)", async () => {
    const fetchImpl = fakeFetch([[/esearch\.fcgi/, JSON.stringify({ esearchresult: { idlist: ["1"], count: "1" } })]]);
    const keep = await pmcLicensePrefilter(["PMC1", "PMC2"], ["cc-by", "cc0", "cc-mark", "public-domain"], {
      fetchImpl,
      minIntervalMs: 0,
    });
    expect([...keep]).toEqual(["2"]);
    const url = decodeURIComponent((fetchImpl as unknown as { calls: string[] }).calls[0]).replace(/\+/g, " ");
    expect(url).toContain('"cc by-nc license"[filter]');
    expect(url).not.toContain('"cc by license"[filter]');
  });
});
