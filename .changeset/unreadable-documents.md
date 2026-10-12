---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": patch
"@promptowl/contextnest-cli": patch
---

**One unreadable file no longer takes a vault down, and bare ids find the document they created.**

- A document whose frontmatter does not parse or has the wrong shape (`tags: 5`, a scalar), or (in an encrypted vault) whose sealed bytes do not open with the vault's key, is skipped by listing and search instead of failing them for the whole vault — and a write no longer reports failure after landing because of one. `context_verify` and `ctx verify` name it as `unreadable_document`. A checkpoint sealed while a document is unreadable carries forward the entry the previous checkpoint held for it, so the chain never records a deletion that did not happen. A single scalar tag (`tags: project`, as Obsidian writes it) now reads as a one-tag list.
- A vault whose key is missing or wrong, or whose files are sealed under a key its config does not hold, still refuses to read — never listing empty. `encryptVault` refuses to mint a new key while sealed files are present and the config is gone.
- `context_import` refuses a document that would not read (a host restoring a whole vault keeps what it brings).
- `context_verify` reports a `history.yaml` that is a folder or a link as `unreadable_history`; it used to drop the document from the check and pass.
- A bare id (`doc`) that names no document resolves to the one `context_create` made for it (`nodes/doc`) in `context_update`, `context_get`, `context_delete`, `context_forget` and `context_forget_log`; a document at the bare id itself still wins (flat vaults). Every such id is validated before anything is read for it.
- New: `NestStorage.readDocumentText(id, raw)` reads a document from text as the vault would read it from disk; `discoverDocuments` takes `onUnreadable`; `FrontmatterShapeError` and `ForeignVaultKeyError` are exported.
