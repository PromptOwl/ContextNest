---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**Structure rules: a nest owner can enforce folder layout, naming formats, placement and templates.**

- New optional `.context/config.yaml` keys (spec §11.1.1): `structure` (`enforce`, `closed`), path-pattern `folders` entries with `types`, `folder_name`, `file_name` (token patterns like `{date}-{slug}` or a guarded `/regex/`), `template`, `required` and `files`, and named `templates` with `required_sections`.
- Every write op enforces them when `structure.enforce` is true — `context_create`, `context_update`, `context_delete`, `context_import` (both `files[]` and `documents[]`), `context_import_pdf`, and the deprecated MCP `create_document` / `update_document`. Refusals are `VALIDATION_FAILED` with a message naming the rule and the expected format; a rule that does not compile refuses writes with `CONFIG_ERROR` and never blocks reads. Existing content is grandfathered.
- A write that creates a folder also creates its required subfolders and files (drafts from their templates).
- New core op `context_structure` (`folder`, `report`) — on the MCP server automatically, and as `ctx structure [--folder] [--report] [--json]`, local and remote with identical JSON. `ctx add` without `--body` starts from the folder's template.
- New engine exports: `compileStructure`, `checkDocument`, `checkUpdate`, `checkFolder`, `checkDeleteDocument`, `checkDeleteFolder`, `scaffoldPlan`, `auditStructure`, `resolveFolder`, `describeStructure`, `enforceStructure`, `setStructure` (rewrites only the rule blocks of `config.yaml`), and `OperationContext.structure: "skip"` for trusted hosts restoring a whole vault.
- **Security:** `context_import` `files[]` no longer writes anything under `.context/` (an import could previously overwrite `config.yaml`, turning off the review gate). Trusted hosts restoring a vault pass `structure: "skip"`.
- Plugin: session start shows the pinned/working-directory vault's rules; the capture and curator agents check `ctx structure` before writing.
