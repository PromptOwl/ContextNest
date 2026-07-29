---
"@promptowl/contextnest-engine": minor
---

Complete the `core` namespace of the API catalog (7 → 15 ops) so all three surfaces (OSS MCP, CLI, Community MCP) can bind to it instead of hand-rolling operations. Added, each with a Zod input/output descriptor + an executor bound to existing engine primitives:

- **Lifecycle:** `context_publish` (`publish_document`), `context_delete` (`delete_document`)
- **History/audit:** `context_versions`, `context_reconstruct` (`read_version`), `context_verify` (`verify_integrity`)
- **Manifest/read:** `context_overview` (`vault_info`), `context_init` (loads CONTEXT.md), `context_packs`

Without these, Phase 2 bindings would still hand-roll delete/publish/history/verify/overview — defeating the convergence goal and failing the PRD's "an OSS agent config works unchanged against a Community server" criterion. All compose engine primitives (`publishDocument`, `deleteDocument`, `readHistory`, `reconstructVersion`, `verifyVaultIntegrity`, `readContextMd`, `readPacks`) — no new logic, no duplicated schemas.
