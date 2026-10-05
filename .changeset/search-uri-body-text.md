---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

`contextnest://search/…` selectors in graph mode (the default for `context_query`, `ctx query` and the deprecated MCP `search` tool) now match body text. They searched only the titles, tags and descriptions in `context.yaml`, so a word that appeared only in a document's body returned nothing. Graph mode now seeds from the same published full-text index `context_search` uses.
