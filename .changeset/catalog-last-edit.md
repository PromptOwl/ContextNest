---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
---

Catalog reads say who last edited a document. `context_get` and `context_list` (with `include_last_edit: true`) can return an optional `last_edit` block, read back from version history: `version`, `edited_by` (the human, always present), `edited_at`, and the write's `client` (so `client.agent` names the agent that made the call). Entries by a `system:` author are skipped. The engine serves it only when the host sets `showEditors: true` on the operation context; it is off by default, so a host that serves public readers leaks no names by upgrading. The bundled MCP server turns it on. Spec §9.5.
