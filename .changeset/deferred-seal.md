---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**Hosts can seal writes later, in a batch.** A new `OperationContext.deferSeal` makes `context_create`, `context_update`, `context_publish`, `context_delete` and `context_import_pdf` stop at the document and its version entry: no nest checkpoint and no index update on the request. A publish answers `checkpoint: null` (the `context_publish` output schema now allows it). The host then calls `sealWrites(storage, { changed, published, triggeredBy })`, which seals every published document in one checkpoint and updates the index once, under the vault lock. `writePublishedVersion` (a publish without its checkpoint) is exported too. Version chains are written on the request, so `verify` is clean before and after the seal. The CLI and MCP server never defer: nothing changes for them.
