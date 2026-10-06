---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-mcp-server": patch
---

**A publish lists the vault once instead of twice.** Sealing the checkpoint and rebuilding the index after a publish each read and parsed every document in the vault. The checkpoint's listing is now handed to the index rebuild, which uses it instead of listing again (`regenerateIndex` takes it as `docs`; `publishDocument` returns it as `vaultDocs`). Applies to `context_publish`, create/update with publish, review approval, bulk `context_import`, and the MCP server's publish tools. Without a document cache (the CLI and the MCP server) this halves the reads a publish makes on a large or network-mounted vault.
