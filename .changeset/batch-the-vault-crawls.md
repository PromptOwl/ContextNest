---
"@promptowl/contextnest-engine": patch
---

Read the whole-vault crawls in parallel batches instead of one file at a time.

`discoverDocuments`, `findAllHistories` and the per-folder `INDEX.md` writes in
`regenerateIndex` each walked their files with an `await` inside a loop. On a
local disk that is free; on a network-backed vault mount every read is a round
trip, so a crawl cost one latency per file — and a bulk publish runs three such
crawls, which is what made importing a few hundred documents take minutes.

Batching overlaps those round trips. Ordering and error handling are unchanged:
documents still come back sorted by id, and an unreadable history is still
skipped and reported through `onUnreadable` exactly once.

Bulk publish already batched its per-document work through its own sliding
window; both now share one helper, so there is a single implementation of
"bounded-parallel map, preserving order". Publish keeps its own (lower) default
and its caller-configurable `concurrency` option — its unit is a document, each
costing several file operations, so the two bounds describe different amounts of
in-flight I/O.
