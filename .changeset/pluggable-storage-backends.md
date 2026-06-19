---
"@promptowl/contextnest-engine": minor
---

Add pluggable storage backends. The engine's storage layer is now abstract — `BaseNestStorage` declares the full domain-level contract, and three concrete backends extend it:

- **`NestStorage`** (filesystem, default) — unchanged public surface. All current callers (CLI, MCP, Desktop, third-party vault tools) keep working with zero code changes.
- **`MongoNestStorage`** (MongoDB) — new. Takes a connected `Db` instance (caller owns the `MongoClient`). Defaults to 7 collections (`documents`, `histories`, `checkpoints`, `suggestions`, `packs`, `chain_events`, `nest`); every name is override-able via the `collections` config. Multi-collection writes wrapped in `session.withTransaction(...)` — requires a Mongo replica set or Atlas (4.0+).
- **`GcsNestStorage`** (Google Cloud Storage) — stub. Class shell reserves the surface; every method throws `Error("GcsNestStorage: not yet implemented")` until the implementation lands in a follow-up.

`mongodb` and `@google-cloud/storage` are **optional peer dependencies** — CLI / MCP installs that never use a cloud backend don't pay the install cost.

Engine modules (`publish`, `hygienist`, `GraphQueryEngine`, `CheckpointManager`, etc.) now type-hint `BaseNestStorage` instead of the concrete `NestStorage`. Any concrete subclass slots in. Internal refactor only — no behavior change for the file backend.

`mongodb-memory-server` added as a dev-only dependency to power the new MongoDB backend test suite (22 end-to-end cases covering create, publish, drift, integrity, derived index, suggestions, chain events, collection-name overrides).
