---
"@promptowl/contextnest-mcp-server": patch
---

MCP writes no longer vanish on first run. `create_document` and `context_create` (with an explicit `id`) re-root a path outside `nodes/` and `sources/` under `nodes/`, so the document shows up in list, search and agent context, and the result carries a `placement` note saying where it went. A create held for review now also tells the agent it is not searchable, and agents won't see it, until approved. Mirrors the CLI's `ctx add` / `ctx search` hints.
