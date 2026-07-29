---
"@promptowl/contextnest-engine": minor
---

Add `@promptowl/contextnest-engine/api` — the canonical operation catalog, so the CLI, MCP, and REST surfaces stop hand-rolling the same operations (API convergence Phase 1).

- **Catalog (schemas)** — `core` namespace (`context_get` / `context_query` / `context_resolve` / `context_list` / `context_search` / `context_create` / `context_update`): Zod input/output + draft-07 JSON Schema (`inputJsonSchema` / `outputJsonSchema`). Canonical names are `context_*`; OSS legacy names (`read_document`, `resolve`, …) are captured as `aliases`. Schemas compose the engine's existing domain schemas — no duplication.
- **Executable ops** — `createEngineApi().run(name, input, ctx)` is the single implementation, bound to the engine primitives (`GraphQueryEngine`, `NestStorage`, `publishDocument`). Ungated mechanics only: published-only search, index regeneration after publish, status/tag normalization, and `validateDocument` before write. Preserves the AGPL↔Commercial line — no governance policy in the engine.
- **Extension framework** — `EngineExtension` generalizes the existing `RbacHook` bridge seam: consumers register new operations (governance/workflow/sync) and wrap every op with `authorize` (throw to deny) + `onResult`, without forking. `NAMESPACES` advertises the implemented set for MCP `initialize` / REST manifest discovery.
