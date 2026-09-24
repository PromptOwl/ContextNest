---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

`contextnest://` links are graph edges in body-link traversal, not just `[[wikilinks]]`

`traverseWikiGraph` — the hop-traversal primitive consumers use over document
bodies — only followed `[[wikilinks]]`, so a node linked by the spec's own link
form, `[text](contextnest://nodes/…)`, was never reached at any hop count while
a `[[wikilink]]` at the same distance was. It now follows both: a
`contextnest://` link, including the pinned and anchored forms
(`contextnest://nodes/foo@3#bar`), produces the same edge a `[[nodes/foo]]`
wikilink does. Dangling links are dropped; links inside code spans and fences
are ignored, as for wikilinks. `resolveWikiSeeds` / `resolveWikiTarget` accept
`contextnest://` seeds. New exports: `extractLinkedIds` (every node a body links
to, both forms, resolved), `resolveContextLink`, `contextLinkTarget` (the
shared pin/anchor stripping `buildRelationships` now also uses).

Index-time edges now agree with traversal on *whether* a link is an edge, not
only on where it points: `buildRelationships` (context.yaml, backlinks) no
longer emits a `reference` edge for a local `contextnest://` link whose target
is not a published document — a dangling node link, a draft, or a
tag/folder/search URI. These are counted in the new
`RelationshipStats.unresolvedContextLinks` and reported by `ctx index`.
Cross-namespace links (with an authority) still produce an edge to their full
URI. Self-links via `contextnest://` are dropped, as they already were for
wikilinks.
