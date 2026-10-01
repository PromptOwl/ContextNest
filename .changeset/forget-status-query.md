---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

An explicit `status:forgotten` selector now returns the forgotten stub from `ctx query`, `context_query` and the query-backed resolve surfaces (spec §6.3.3). The query engine matched the stub and then dropped it in its retrieval gate, and its default (graph) mode reads a published-only `context.yaml` that never holds stubs. A selector that asks for `status:forgotten` in a positive position now runs in full mode and keeps stubs; every other selector still hides them.
