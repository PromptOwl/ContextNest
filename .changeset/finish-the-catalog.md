---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

The rest of the core operations become the shared path

Search, selector query, resolution, publish, delete and version reconstruction were the last core operations each surface still implemented privately. They now run through the catalog, which completes the core namespace.

**A version that does not exist returned a different version's content.** Reconstruction starts at the nearest keyframe at or before the version asked for and replays change logs forward. Ask for a version the history does not contain and there is nothing to replay, so it returned the keyframe's content as though it were the version requested — silently, in the one place that must never give a silently wrong answer. It refuses now. This surfaced a regression test that had been passing on exactly that wrong content: it asked for version 2 of a document left at version 1 and matched on a title both versions share.

Three operations gained what a surface needed before it could adopt them:

- `context_query` takes `include_drafts`, for authoring surfaces where the point is finding the draft you are working on. Without it, adoption would have silently dropped `ctx query --include-drafts`.
- `context_publish` takes a version-history `note` and returns the `chain_hash`, both of which `ctx publish` reports.
- `context_delete` returns the deleted node's `title`, read before removal — after the delete there is nothing left to ask.

Node summaries now carry `description` when the document has one.

`ctx search`, `query`, `publish`, `delete` and `reconstruct` run through the catalog; `ctx search` gains `--limit`. Six more MCP tools are registered, with `search`, `resolve`, `publish_document`, `delete_document` and `read_version` kept, unchanged, and marked deprecated.

Two commands deliberately stay on their own implementations, and the reason is worth recording. `ctx verify` checks each document chain and reports unreadable histories per document, which is strictly more than the vault-level integrity operation. And `ctx resolve` evaluates a selector and lists what matches — despite the shared word, that is not `context_resolve`, which returns full bodies within a token budget.
