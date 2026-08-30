---
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

Refuse unknown write parameters instead of silently dropping them, and accept `body`/`content` as aliases.

A caller that misnamed a parameter — `content` where `update_document` takes `body` — got a success response for a write that never landed: zod's default object mode stripped the key, the handler saw no body, the version bumped, `updated_at` moved, and a checkpoint and chain hash were written over unchanged text. The only way to notice was to read the document back and compare.

- `EngineApi.run()` now rejects any key an operation's input schema does not declare (`VALIDATION_FAILED`, naming the unknown keys and listing the accepted ones).
- The MCP server registers every tool through `registerTool` with a strict ZodObject, so the schema it publishes (`additionalProperties: false`) is the one it enforces. Previously it advertised strictness and stripped instead.
- `context_create` / `context_update` accept `body` as an alias for `content`, and `create_document` / `update_document` accept `content` as an alias for `body`. Two values that disagree are refused rather than resolved by preference.
- `context_create`, `context_update`, `create_document` and `update_document` take a `description`. It is one of the three fields the metadata index matches on, so a node without one is markedly harder to retrieve; update clears it with an empty string, matching `metadata`'s null convention.
- `list_documents` gains the `path` filter its canonical twin `context_list` has as `folder`, matching on segment boundaries.

Also: make `type: source` nodes writable at all.

`create_document` built a `skill:` block for skill nodes but had no `source` equivalent, and skipped `validateDocument` entirely. A `type: source` node was therefore written and published with no `source:` block — which §13 rule 9 requires, but only enforces on the way out. Every subsequent update then failed validation, with no parameter able to supply the missing field: the node was write-once, recoverable only by `delete_document`, which destroys its version history. `context_create` was better behaved (it validates, so it failed loudly) but source nodes were simply uncreatable there.

- New `applyTypedBlocks` settles `source` and `skill` against a node's post-write `type` BEFORE anything is written, shared by `context_create`, `context_update`, `create_document` and `update_document`. Entering `source`/`skill` requires that block (rules 9 / 18); leaving it drops the old one (rules 17 / 19).
- `context_create` and `create_document` take a `source` block; `create_document` now validates before the write, so an invalid create leaves nothing on disk.
- `context_update` and `update_document` take `type`, `source`, `trigger`, `tools_required` and `output_format`, so a node broken by this bug can be repaired without losing its history, and a node can be re-typed with its block swapped in the same call.
- `sourceMetaSchema` is exported, so the write operations accept a source block against the same shape frontmatter validation enforces.
