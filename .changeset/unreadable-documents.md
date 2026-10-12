---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-mcp-server": patch
"@promptowl/contextnest-cli": patch
---

**One unreadable file no longer takes a vault down, and bare ids find the document they created.**

- A document whose frontmatter does not parse, or (in an encrypted vault) whose sealed bytes do not open with the vault's key, is skipped by listing, search and checkpoints instead of failing them for the whole vault — and a write no longer reports failure after landing because of one. `context_verify` names it as `unreadable_document`. A vault whose key is missing or wrong still refuses to read.
- `context_import` refuses such a file instead of landing it (a host restoring a whole vault keeps what it brings).
- `context_verify` reports a `history.yaml` that is a folder or a link as `unreadable_history`; it used to drop the document from the check and pass.
- A bare id (`doc`) that names no document resolves to the one `context_create` made for it (`nodes/doc`) in `context_update`, `context_get`, `context_delete`, `context_forget`, `context_forget_log` and the skill operations; a document at the bare id itself still wins (flat vaults).
- New: `NestStorage.readDocumentText(id, raw)` reads a document from text as the vault would read it from disk.
