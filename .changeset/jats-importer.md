---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

Import scientific literature as markdown twins: `ctx import jats`, `ctx import pubmed`, `ctx enrich pubtator`

**Engine** gains `jatsToDocument()` — a deterministic, offline JATS XML →
markdown converter (PubMed Central `*.nxml`, publisher deposits, AGA's
`nigel-enrich` envelope). The twin's frontmatter carries the NLM-curated graph
as query tags (`#pubtype-srma`, `#year-2024`, `#journal-…`, keywords,
`#license-cc-by`, `#status-retracted`, `#has-erratum`) and `metadata` holds
`doi` / `pmid` / `pmcid`, authors, the parsed reference list and
`source_sha256`. The body keeps one paragraph per line with its JATS id as a
trailing block anchor (`… ^p_4_2`), GFM tables, figure captions, LaTeX math
and numbered references. `linkCitations()` / `buildCitationIndex()` turn
references that name another paper in the vault into `[[wikilinks]]`.

**CLI**: `ctx import jats <paths…>` (idempotent on `source_sha256`, one
checkpoint per batch, `--keep-xml`, re-links earlier papers when a cited one
arrives), `ctx import pubmed --term …` (E-utilities → PMC open-access JATS →
same importer), and `ctx enrich pubtator` (NCBI PubTator 3 entities and
relations, MeSH-normalised, promoted to `#mesh-` tags). NCBI's 3 req/s limit
is throttled and retried; `NCBI_API_KEY` raises it.

`ctx read --html` now renders `[[wikilinks]]`, trailing block anchors,
pandoc-style `^sup^` / `~sub~` and escaped pipes in table cells.
