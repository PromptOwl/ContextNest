import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { esearch, meshTag, pubtatorFetch, resolvePmid, summarizePubTator } from "../pubmed.js";

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
});
