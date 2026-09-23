---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-mcp-server": patch
"@promptowl/contextnest-cli": patch
---

Graph queries return the same documents in the same order every time, and a hub no longer pulls in everything that links to it

**Order.** `readDocuments` filled its result map as each parallel file read
settled, so the same `ctx query` against the same vault could return the same
set in a different order from run to run. It now returns documents in the order
requested, which makes graph-mode results stable run to run.

**Hub direction.** "Edges to a hub are free" was also applied when walking an
edge backwards, so seeding a hub (for example with a tag the hub carries) pulled
in every document that links to it at zero hop cost, even with `--hops 0`. The
free rule now follows the direction of travel: reaching a hub is free, leaving
one costs a hop, and walking back along `depends_on` (to a dependent rather than
a dependency) costs a hop.

The spec now documents behavior the engine already had: the keyframe cadence
(versions 1, 11, 21, …), hash-input normalization (BOM stripped, line endings
to LF), the delete-and-recreate exception to `cross_chain_mismatch`, and the
traversal cost rules for `hops` (new §5.1.1).
