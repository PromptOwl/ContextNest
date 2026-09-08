---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

Selectors accept a bare node id, and one grammar line is published everywhere.

`ctx query "nodes/gtm/foo"` and `ctx resolve "nodes/gtm/foo"` now select that one node: a token starting with `nodes/` or `sources/` lexes as the same URI atom as `contextnest://nodes/gtm/foo`, composes with the rest of the grammar (`nodes/gtm/foo + #strategy`, `nodes/a | nodes/b`, `nodes/a - #old`), and terminates on the same delimiters the scheme form does. `sources/<id>` does the same for a source node. A bare word without that prefix still fails with `INVALID_SELECTOR`, but the message now suggests the fix: `Unexpected token "gtm/foo" at position 0 — did you mean "nodes/gtm/foo" (a node id) or "#gtm/foo" (a tag)?`. An unknown `word:` filter lists the valid ones (`type, status, tag, pack, transport, server`). The quoted spelling of a bad token (`"gtm/foo"`) gets the same hint instead of an opaque `INVALID_URI` from a layer down.

The engine exports a single `SELECTOR_GRAMMAR` constant and every surface that teaches the grammar renders it verbatim, replacing four copies that disagreed with the lexer: `ctx query --help` and `ctx resolve --help` (previously no grammar at all), the `ctx init` banner (advertised `path:` and `&`, which throw, and called `+` "union"), the CLI README Selectors section (labelled `#api + #v2` as Union), the generated CLAUDE.md / agent-config block (gains a `nodes/<id>` example), and the `context_query` and `context_resolve` tool descriptions (`context_query` claimed `[[Title]]` and `scope:`, which the lexer does not accept; `context_resolve` taught no grammar at all). `CONTEXT_NEST_SPEC.md` §2.1 lists the new atom, so the normative source agrees too. Structural tests hold each surface to the constant, and the line is ASCII so it survives a legacy Windows console. Real `path:` / `folder:` filters remain out of scope.
