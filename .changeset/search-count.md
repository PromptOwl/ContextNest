---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

**`context_search` returns `count`, the total number of matches, next to `results`.**

With `limit` set, a capped page could read as the whole answer. `searchOp.output` now has a required `count: z.number().int().nonnegative()`, filled with every published match *before* the `limit` slice. The name matches the hosted REST and MCP search responses, which already return `count`. `total`, which carried the same number, stays as a deprecated alias so existing clients keep working. `ctx search` (local and remote) reads `count` first and falls back to `total`, so its "… N more — raise --limit" footer now also appears against a hosted nest that sends only `count`.
