---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**Hosts can supply the vault manifest themselves.** New `NestStorage` option `manifest`: a function returning every document's `manifestEntry`, from a record the host updates with each document write (the hosted Community server will serve it from its database). With it, a write's index update and checkpoint take the vault's documents from that record: no vault crawl, no folder re-reads, and no manifest file or pending list on disk. It works without `CONTEXTNEST_MANIFEST`. Returning `null` falls back to the crawl. `manifestEntry` and `ManifestEntry` are now exported, and manifest entries carry `updated_at` so INDEX.md can be built from them. The CLI and MCP server do not set the option: nothing changes for local vaults.
