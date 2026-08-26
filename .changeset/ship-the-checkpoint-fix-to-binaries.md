---
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

Pick up the checkpoint-chain write fix, and stop `ctx index` reading the whole chain.

Both binaries compile the engine into `dist/` and declare it as a devDependency, so an engine-only release would leave installed copies still running the old code — the checkpoint fix reaches `ctx` and the OSS MCP server only when they are rebuilt and republished. Every write path in both already routes through `publishDocument` / `publishDocuments` / `storage.regenerateIndex()`, so no call-site change was needed for them to inherit it.

`ctx index` was the one exception. It reimplements `regenerateIndex` inline and carried its own copy of the whole-chain read for a single field (`checkpoints.at(-1)`); it now takes the head through `readLatestCheckpoint()` like the engine does. One-shot rather than per-write, so it was never part of the timeout, but it is the same O(chain size) cost.
