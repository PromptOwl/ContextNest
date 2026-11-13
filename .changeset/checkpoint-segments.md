---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
---

**The checkpoint chain no longer grows one huge file, and a write no longer pays for the whole history.** Every seal used to append a whole checkpoint (the version and chain hash of every published document) to a single `.versions/context_history.yaml`. On a network-backed mount (GCS FUSE on Cloud Run) each append re-uploads the whole object, so a 340-document vault had 350–885 MB chain files and spent ~4.5 s of every write in `appendCheckpoint`.

- New seals go to segment files under `.versions/.checkpoints/` (`000000001.yaml`, …). Each segment opens with one full checkpoint, and every later entry records only what changed (`changed_versions` / `changed_chain_hashes`, plus `removed_*` when a document leaves). A seal appends to the newest segment only, and a new segment starts every 500 checkpoints (new `NestStorage` option `checkpointsPerSegment`). The bytes a seal writes, and the file it rewrites, no longer depend on how long the chain is. `checkpoint_hash` is still computed over the full maps, so the chain verifies exactly as before (spec §7.2 updated).
- **Existing vaults migrate lazily.** A legacy `context_history.yaml` keeps reading and verifying. The next seal starts the first segment, linked to its last checkpoint, and the legacy file is never written again (no rewrite on the write path). `ctx checkpoint rebuild` replaces both with segments.
- `readCheckpointHistory`, `readLatestCheckpoint`, `readCheckpointChainState`, `sealWrites`, `context_verify` and `scanCheckpointDrift` keep their signatures. `CheckpointChainState`'s `head` gains an optional `segment`. An unreadable newest segment is quarantined along with the rest of the chain (`.versions/.checkpoints.corrupt-<time>/`), the same as an unreadable `context_history.yaml` before.
- Imports carry segment files (`.versions/.checkpoints/<n>.yaml`) like the other root ledgers, so an export restores with its chain.
- **Don't roll back to an older engine after a vault has migrated.** An older engine reads only `context_history.yaml`, so it would append from the pre-migration head and fork the chain. `verify` reports the fork, and `ctx checkpoint rebuild` repairs it.
