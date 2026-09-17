import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseDocument, validateDocument } from "../parser.js";
import { jatsToDocument, linkCitations, splitJatsArticles } from "../importers/jats.js";

// CU-wdqcq02c6w: JATS (PubMed Central / publisher XML) → markdown twin whose
// frontmatter carries the NLM graph as query tags. Deterministic, no LLM.

const here = dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(join(here, "fixtures", "jats-sample.xml"), "utf8");

describe("jatsToDocument — identity & frontmatter", () => {
  const r = jatsToDocument(xml, { sourcePath: "sample.jats.xml" });
  const doc = parseDocument(r.path, r.content, r.path.replace(/\.md$/, ""));

  it("keys the node on PMID when present", () => {
    expect(r.path).toBe("nodes/papers/pmid-99900001.md");
    expect(r.slug).toBe("pmid-99900001");
  });

  it("validates against the frontmatter schema", () => {
    expect(validateDocument(doc).valid).toBe(true);
    expect(doc.frontmatter.type).toBe("reference");
    expect(doc.frontmatter.status).toBe("published");
  });

  it("carries a plain-text title and an abstract-derived description", () => {
    expect(doc.frontmatter.title).toBe(
      "Fecal Microbiota Transplantation for Clostridioides difficile: A Synthetic Trial",
    );
    expect(doc.frontmatter.description).toMatch(/^Background: recurrent infection is common\./);
    expect(doc.frontmatter.description!.length).toBeLessThanOrEqual(500);
  });

  it("turns the NLM graph into query tags", () => {
    const tags = doc.frontmatter.tags ?? [];
    expect(tags).toEqual(
      expect.arrayContaining([
        "#paper",
        "#pubtype-research-article",
        "#pubtype-srma",
        "#voice-normative",
        "#year-2024",
        "#journal-j-synth-gastro",
        "#license-cc-by",
        "#has-erratum",
        "#fecal-microbiota-transplantation",
        "#clostridioides-difficile-infection",
        "#kw-2-step-protocol", // a keyword may not start with a digit (TAG_PATTERN)
      ]),
    );
  });

  it("stores identifiers and provenance under metadata", () => {
    const m = doc.frontmatter.metadata as Record<string, unknown>;
    expect(m.pmid).toBe("99900001");
    expect(m.pmcid).toBe("PMC9990001");
    expect(m.doi).toBe("10.9999/jsg.2024.001");
    expect(m.journal).toBe("Journal of Synthetic Gastroenterology");
    expect(m.journal_abbrev).toBe("J Synth Gastro");
    expect(m.year).toBe(2024);
    expect(m.authors).toEqual(["Jane Q. Doe", "Richard Roe"]);
    expect(m.article_type).toBe("research-article");
    expect(m.document_type).toBe("SRMA");
    expect(m.license).toBe("http://creativecommons.org/licenses/by/4.0/");
    expect(m.erratum).toEqual(["10.9999/jsg.2024.099"]);
    expect(m.source_path).toBe("sample.jats.xml");
    expect(m.source_sha256).toBe(createHash("sha256").update(xml).digest("hex"));
    expect(m.paragraph_ids).toEqual(["p_1_1", "p_1_2", "p_2_1", "p_2_2", "p_3_1"]);
    expect(m.refs).toEqual([
      { n: 1, id: "ref1", doi: "10.1016/j.cgh.2018.07.026" },
      { n: 2, id: "ref2", pmid: "12345678" },
      { n: 3, id: "ref3" },
    ]);
  });

  it("is byte-for-byte deterministic and CRLF-agnostic", () => {
    expect(jatsToDocument(xml, { sourcePath: "sample.jats.xml" }).content).toBe(r.content);
    const crlf = jatsToDocument(xml.replace(/\n/g, "\r\n"), { sourcePath: "sample.jats.xml" });
    expect(crlf.content.replace(/\r\n/g, "\n")).toBe(r.content);
  });
});

describe("jatsToDocument — body", () => {
  const { content } = jatsToDocument(xml, { sourcePath: "sample.jats.xml" });
  const body = parseDocument("nodes/papers/x.md", content, "nodes/papers/x").body;
  const lines = body.split("\n");

  it("mirrors the section tree as headings and drops the empty nigel envelope", () => {
    expect(lines).toContain("## Abstract");
    expect(lines).toContain("## Introduction");
    expect(lines).toContain("## Methods");
    expect(lines).toContain("### Statistical Analysis");
    expect(lines).toContain("## Results");
    expect(lines).toContain("## References");
    expect(body).not.toContain("Editorial summary");
  });

  it("keeps every paragraph on ONE line with its JATS id as a trailing block anchor", () => {
    expect(lines).toContain(
      "Fecal microbiota transplantation (FMT) restores the gut community.[1],[2] It is used for *C difficile* infection (CDI) with **high** cure rates. ^p_1_1",
    );
  });

  it("renders sup/sub in pandoc style and cross-refs as plain text", () => {
    expect(lines).toContain(
      "Colony counts reach 10^9^ CFU/g; H~2~O is the diluent (Table 1, Figure 1). ^p_1_2",
    );
  });

  it("keeps math as LaTeX", () => {
    expect(body).toContain("modelled as $p = \\frac{k}{n}$ and pooled by ^p_2_1");
    expect(lines).toContain("$$\\hat{p} = \\frac{\\sum k_i}{\\sum n_i}$$");
  });

  it("emits a markdown table with an escaped pipe and a caption line", () => {
    expect(lines).toContain("**Table 1.** Donor screening panel");
    expect(lines).toContain("| Test | Threshold |");
    expect(lines).toContain("| --- | --- |");
    expect(lines).toContain("| Serum HIV \\| HBV | Negative |");
  });

  it("emits figures as captioned blockquotes", () => {
    expect(lines).toContain("> **Figure 1.** Study flow");
  });

  it("formats element and mixed citations uniformly", () => {
    expect(lines).toContain(
      "1. Vaughn B.P., Rank K.M., Khoruts A. Fecal microbiota transplantation: current status. Clin Gastroenterol Hepatol. 2019;17:353–361. doi:10.1016/j.cgh.2018.07.026",
    );
    expect(lines).toContain("2. Smith A, Jones B. A mixed citation. J Example. 2020;1:1-2. pmid:12345678");
    expect(lines).toContain("3. GBD Collaborators. A Book Title. 2018.");
  });

  it("opens with the title and a one-line citation header", () => {
    expect(lines[0]).toBe(
      "# Fecal Microbiota Transplantation for *Clostridioides difficile*: A Synthetic Trial",
    );
    expect(lines).toContain(
      "> Jane Q. Doe, Richard Roe · J Synth Gastro 2024;12(3):100–110 · doi:10.9999/jsg.2024.001 · PMID 99900001 · PMC9990001",
    );
  });
});

describe("jatsToDocument — governance signals", () => {
  it("flags a retracted article without hiding it", () => {
    const retracted = xml.replace(
      'related-article-type="correction-forward"',
      'related-article-type="retraction-forward"',
    );
    const r = jatsToDocument(retracted, { sourcePath: "r.xml" });
    const doc = parseDocument(r.path, r.content, r.path.replace(/\.md$/, ""));
    expect(doc.frontmatter.status).toBe("published");
    expect(doc.frontmatter.tags).toContain("#status-retracted");
    expect(doc.frontmatter.tags).not.toContain("#has-erratum");
    expect((doc.frontmatter.metadata as Record<string, unknown>).retracted_by).toEqual([
      "10.9999/jsg.2024.099",
    ]);
    expect(doc.body.split("\n")[2]).toMatch(/^> ⚠️ \*\*RETRACTED\*\*/);
  });

  it("escapes a literal backslash in a table cell so the renderer cannot misread it", () => {
    const withBackslash = xml.replace("Serum HIV | HBV", "Serum HIV \\ HBV");
    const body = parseDocument("x.md", jatsToDocument(withBackslash).content, "x").body;
    expect(body.split("\n")).toContain("| Serum HIV \\\\ HBV | Negative |");
  });

  it("falls back to DOI, then PMCID, then title for the node id", () => {
    const noPmid = xml.replace('<article-id pub-id-type="pmid">99900001</article-id>', "");
    expect(jatsToDocument(noPmid).slug).toBe("doi-10-9999-jsg-2024-001");
    const noDoi = noPmid.replace('<article-id pub-id-type="doi">10.9999/jsg.2024.001</article-id>', "");
    expect(jatsToDocument(noDoi).slug).toBe("pmc9990001");
    const nothing = noDoi.replace('<article-id pub-id-type="pmc">PMC9990001</article-id>', "");
    expect(jatsToDocument(nothing).slug).toBe(
      "fecal-microbiota-transplantation-for-clostridioides-difficile-a-synthetic-trial",
    );
  });

  it("honours a custom folder", () => {
    expect(jatsToDocument(xml, { folder: "nodes/lit" }).path).toBe("nodes/lit/pmid-99900001.md");
  });
});

describe("jatsToDocument — untrusted input", () => {
  const withLinks = xml.replace(
    "<p id=\"p_3_1\">Clinical resolution occurred in 32 of 40 patients.</p>",
    `<p id="p_3_1">See <ext-link ext-link-type="uri" xlink:href="https://example.org/trial">the registry</ext-link>, ` +
      `<ext-link xlink:href="javascript:alert(1)">this</ext-link> and ` +
      `<ext-link xlink:href="data:text/html,x">that</ext-link>.</p>`,
  );

  it("links only web/mail schemes; javascript:/data: hrefs stay plain text", () => {
    const body = parseDocument("x.md", jatsToDocument(withLinks).content, "x").body;
    expect(body).toContain("[the registry](https://example.org/trial)");
    expect(body).toContain("this (javascript:alert(1))");
    expect(body).not.toContain("](javascript:");
    expect(body).not.toContain("](data:");
  });

  it("trims trailing punctuation from a DOI found in an ext-link href", () => {
    const doiLink = xml.replace(
      '<pub-id pub-id-type="doi">10.1016/j.cgh.2018.07.026</pub-id>',
      '<ext-link xlink:href="https://doi.org/10.1016/j.cgh.2018.07.026).">link</ext-link>',
    );
    expect(jatsToDocument(doiLink).meta.refs[0].doi).toBe("10.1016/j.cgh.2018.07.026");
  });

  it("keeps only the first anchor for a duplicated paragraph id and warns", () => {
    const dup = xml.replace('<p id="p_1_2">', '<p id="p_1_1">');
    const r = jatsToDocument(dup);
    expect(r.meta.paragraph_ids.filter((id) => id === "p_1_1")).toHaveLength(1);
    expect(r.warnings).toContain('duplicate paragraph id "p_1_1"; anchor kept on the first only');
    const anchors = r.content.split("\n").filter((l) => l.endsWith(" ^p_1_1"));
    expect(anchors).toHaveLength(1);
  });
});

describe("jatsToDocument — publisher variations", () => {
  it("finds a reference list wrapped in <back><sec> and refs nested in sub-lists", () => {
    const wrapped = xml
      .replace("<ref-list>", '<sec sec-type="references"><ref-list><title>Refs</title><ref-list>')
      .replace("</ref-list>", "</ref-list></ref-list></sec>");
    const r = jatsToDocument(wrapped);
    expect(r.meta.refs.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(r.content).toContain("## References");
  });

  it("warns when <back> exists but carries no references", () => {
    const none = xml.replace(/<ref-list>[\s\S]*<\/ref-list>/, "<fn-group/>");
    const r = jatsToDocument(none);
    expect(r.meta.refs).toEqual([]);
    expect(r.warnings).toContain("<back> present but no <ref> found; citation graph will be empty");
  });

  it("drops a malformed PMID with a warning and falls back to the DOI id", () => {
    const bad = xml.replace('<article-id pub-id-type="pmid">99900001</article-id>', '<article-id pub-id-type="pmid">99900001&amp;x=1</article-id>');
    const r = jatsToDocument(bad);
    expect(r.meta.pmid).toBeUndefined();
    expect(r.slug).toBe("doi-10-9999-jsg-2024-001");
    expect(r.warnings.some((w) => w.startsWith("ignoring malformed PMID"))).toBe(true);
  });
});

describe("splitJatsArticles", () => {
  it("returns a single-article file whole and splits an articleset per article", () => {
    expect(splitJatsArticles(xml)).toEqual([xml]);
    const second = xml.replace(/^<\?xml[^>]*>\s*/, "").replace("99900001", "99900002");
    const set = `<?xml version="1.0"?><pmc-articleset>${xml.replace(/^<\?xml[^>]*>\s*/, "")}${second}</pmc-articleset>`;
    const parts = splitJatsArticles(set);
    expect(parts).toHaveLength(2);
    expect(jatsToDocument(parts[0]).slug).toBe("pmid-99900001");
    expect(jatsToDocument(parts[1]).slug).toBe("pmid-99900002");
    expect(jatsToDocument(parts[0]).sha256).not.toBe(jatsToDocument(parts[1]).sha256);
  });
});

describe("linkCitations — in-vault citation graph", () => {
  it("wikilinks reference lines whose DOI/PMID match a vault paper and records cites", () => {
    const r = jatsToDocument(xml, { sourcePath: "sample.jats.xml" });
    const linked = linkCitations(r.content, {
      byDoi: new Map([["10.1016/j.cgh.2018.07.026", "nodes/papers/doi-10-1016-j-cgh-2018-07-026"]]),
      byPmid: new Map([["12345678", "nodes/papers/pmid-12345678"]]),
    });
    expect(linked.changed).toBe(true);
    const doc = parseDocument(r.path, linked.content, r.path.replace(/\.md$/, ""));
    const lines = doc.body.split("\n");
    expect(lines).toContain(
      "1. Vaughn B.P., Rank K.M., Khoruts A. Fecal microbiota transplantation: current status. Clin Gastroenterol Hepatol. 2019;17:353–361. doi:10.1016/j.cgh.2018.07.026 → [[nodes/papers/doi-10-1016-j-cgh-2018-07-026]]",
    );
    expect(lines).toContain(
      "2. Smith A, Jones B. A mixed citation. J Example. 2020;1:1-2. pmid:12345678 → [[nodes/papers/pmid-12345678]]",
    );
    expect((doc.frontmatter.metadata as Record<string, unknown>).cites).toEqual([
      "nodes/papers/doi-10-1016-j-cgh-2018-07-026",
      "nodes/papers/pmid-12345678",
    ]);
    // Idempotent: a second pass over already-linked content changes nothing.
    const again = linkCitations(linked.content, {
      byDoi: new Map([["10.1016/j.cgh.2018.07.026", "nodes/papers/doi-10-1016-j-cgh-2018-07-026"]]),
      byPmid: new Map([["12345678", "nodes/papers/pmid-12345678"]]),
    });
    expect(again.changed).toBe(false);
    expect(again.content).toBe(linked.content);
  });

  it("is a no-op when nothing matches", () => {
    const r = jatsToDocument(xml);
    const out = linkCitations(r.content, { byDoi: new Map(), byPmid: new Map() });
    expect(out.changed).toBe(false);
    expect(out.content).toBe(r.content);
  });
});
