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
