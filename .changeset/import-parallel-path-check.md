---
"@promptowl/contextnest-engine": patch
---

**Folder import does less storage I/O.** On a network-backed vault (Cloud Storage via gcsfuse) every file operation is a round trip, and a few hundred documents paid several of them each in places where none were needed.

- `context_import` checks whether its incoming files already exist in the vault in parallel, not one file at a time. Path planning is unchanged: same targets, same `-2`/`-3` collision numbering, same warnings.
- A checkpoint sealed with no readable head (the first one in a new or freshly imported nest, or after an unreadable `context_history.yaml`) no longer walks the vault and reads every `history.yaml`. It takes the hashes the publish just sealed and reads history only for published documents those don't cover, as a seal on top of an existing head already did.
- `publishDocuments` takes an optional `preloaded` map of documents the caller already read under the same lock; discover-mode `context_import` passes its scan, so each document is no longer read a second time before it is published.
- Publishing a document with no history lists its `.versions/` directory once instead of twice (`nextVersion` and `createVersion` accept an optional `knownSealed`).

Sealed versions, chain hashes and checkpoints are the same as before.
