---
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-engine": minor
---

`ctx import pubmed` searches PubMed, filters by licence, and tags MEDLINE publication types.

- **Search goes to PubMed, not PMC.** PMC's esearch silently ignores MeSH (`[mh]`, `[majr]`) and publication-type (`[pt]`) qualifiers, so `chronic pain[mh] AND systematic review[pt]` used to import unrelated case reports and trials. The term now runs against db=pubmed restricted to PMC full text (`"pubmed pmc"[sb]` is added unless present); PMIDs map to PMCIDs via esummary and the JATS is fetched from PMC as before. Behaviour change: the summary line reads "N match(es) in PubMed with PMC full text", and a term written for PMC's search syntax may match differently.
- **`--license <list>`** (`cc-by,cc0`, `cc-by-nc`, … or `commercial` = CC BY + CC0 + public domain) drops articles under any other licence: a PMC `[uid]` + licence-filter pre-check avoids downloads, and the JATS `<license>` decides (no declared licence → dropped). Drops are reported as skipped.
- **`--max` counts imported articles** (after the licence filter); up to 6× as many candidates are considered (2× without `--license`).
- **`#pubtype-*` comes from MEDLINE publication types** when PubMed's are known (`import pubmed`, `enrich pubtator`): Systematic Review → `#pubtype-systematic-review`, Meta-Analysis → `#pubtype-meta-analysis`, both → `#pubtype-srma`, (Practice) Guideline → `#pubtype-guideline`, RCT → `#pubtype-rct`, Review → `#pubtype-review`, …; the raw list is `metadata.publication_types`. The JATS `article-type` moves to `#article-type-*` on those twins (still `metadata.article_type`); a publisher `custom-meta document_type` tag is kept. Plain `ctx import jats` is unchanged. Publication types survive re-import like PubTator enrichment, an unchanged twin is republished once when its types become known, and `enrich pubtator` re-visits papers enriched before publication types existed.
- Engine: `jatsToDocument(...).meta.license_slug` exposes the normalised licence (`cc-by`, `cc-by-nc`, `cc0`, `cc-mark`, …) the `#license-*` tag carries.
