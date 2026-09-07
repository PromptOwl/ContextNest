---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
---

`[[wikilinks]]` become `reference` edges at index time, so `--hops` works on vaults authored in wiki style.

`buildRelationships()` only extracted `contextnest://` inline links and `depends_on`, so a vault whose documents link each other with `[[Title]]` — the common Obsidian/wiki convention — indexed with an empty `relationships:` list in `context.yaml`. Graph-aware queries then had nothing to traverse: `ctx query --hops N` returned only the seed documents and hubs were empty, with no hint that anything was wrong.

- `buildRelationships()` (and therefore `buildBacklinks()`, so INDEX.md backlinks and `context.yaml` cannot disagree) now resolves `[[Title]]`, `[[title]]` (case-insensitive), `[[Title|alias]]`, `[[Title#anchor]]` and `[[nodes/id]]` through the same `wiki-graph` helpers the query side uses, emitting `{from, to, type: "reference"}` edges. Edges are de-duplicated by (from, to, type) — a doc that links the same target both ways yields one edge — and self-links are dropped. Wikilink edges count toward hubs like any other inbound reference.
- Unresolvable wikilinks produce no edge and are counted. New `buildRelationshipsWithStats()` and `generateContextYamlWithStats()` return `{edges, fromWikilinks, unresolvedWikilinks}` alongside the result; `resolveWikiTarget()` is exported.
- `ctx index` prints `N relationship edges (M from wikilinks, K unresolved)` after `Generated context.yaml`. A non-zero unresolved count is the hint that a link's title matches no published document.
