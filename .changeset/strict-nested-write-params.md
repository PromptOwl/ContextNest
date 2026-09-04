---
"@promptowl/contextnest-mcp-server": patch
"@promptowl/contextnest-engine": patch
---

Refuse unknown keys inside nested write objects too, and let `context_import` carry typed blocks.

The unknown-key guard added alongside the strict MCP tool schemas reads an operation's OUTER shape only, so nested objects went on silently stripping — the same failure it was written to stop, one level down. A bulk import saying `body` instead of `content` published a node with the wrong text; a `source` block with a typo'd `server` was written incomplete and sealed into the chain.

- `importDoc` and `importFile` are strict. The `files[]` case was the sharper one: the executor writes `f.content ?? ""`, so a stripped key landed an EMPTY file and still counted itself in `written`.
- The `source` parameter of `context_create`, `context_update`, `create_document` and `update_document` is strict at each call site. `sourceMetaSchema` itself stays lenient by design — it also parses documents already on disk, where an unrecognized key is a file to keep reading rather than a caller to refuse. Making the base strict would start failing existing vault files.
- `context_import` accepts `description` and the typed-block fields (`source`, `trigger`, `tools_required`, `output_format`, `inputs`, `guard_rails`). `buildDraftNode` already forwarded them to `applyTypedBlocks`, but the schema dropped them first, so `type: source` and `type: skill` nodes could not be imported at all — import was the one write surface the source-node fix missed.
- `metadata` stays permissive; arbitrary keys are its purpose.

Also repairs two handlers mangled in the merge of the vault-lock and strict-schema branches: `create_document` and `update_document` had a block-bodied arrow around `lockedHandler(...)`, whose return value was therefore discarded — the tool resolved `undefined` and the write ran unawaited. Both are back to the concise form the other locked tools use.
