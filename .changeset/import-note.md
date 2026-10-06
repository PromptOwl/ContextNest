---
"@promptowl/contextnest-engine": minor
---

**Publishing reads far less from disk, and bulk approval keeps the reviewer's note.**

- A publish now reads each document's version history once instead of five times, and no longer reads the document back after writing it: the history is reused across picking the next version number, rebuilding the previous version for the diff, and appending the new entry, all under the same lock. The checkpoint takes the chain hash of the entry just appended instead of re-reading the history, and the index rebuild reuses the checkpoint just sealed. Chains, version numbers, diffs and checkpoints are computed exactly as before; only repeated reads are gone. On network-backed storage each of those reads was a round trip.
- `context_import` takes an optional `note`, recorded in the version history of every document the call publishes. With `ids` alone (for example a bulk approval) the batch's single index rebuild rewrites only the folders of those documents.
- New optional inputs for callers that already hold the data: `knownHistory` on `VersionManager.nextVersion`, `createVersion` and `reconstructVersion`; the just-sealed entries on `CheckpointManager.createCheckpointFromVault`; `latestCheckpoint` on `regenerateIndex`; `indexOnlyBatchFolders` on `publishDocuments`. `publishDocument` now also returns the `checkpoint` it sealed. Calls without them behave as before.
