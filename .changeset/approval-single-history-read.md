---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-mcp-server": patch
---

**Approving an external edit or suggestion, rolling back, and publishing from the MCP server now read less from disk.** Approving a staged suggestion reads the document's version history once instead of four times, and a rollback or direct edit once instead of three times; version numbering, diffs and chain hashes are computed exactly as before. The MCP server's create, update and publish tools rebuild only the published document's folder index and reuse the checkpoint the publish just sealed, matching `context_publish`.
