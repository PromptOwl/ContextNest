---
"@promptowl/contextnest-engine": minor
---

Stop making every write pay for the whole checkpoint chain, and stop letting a broken chain block the author.

Writes on a mature vault were timing out while reads stayed instant. The cause was the same file at both ends of every write. `.versions/context_history.yaml` gains one entry per published document per checkpoint and is never pruned, and each write both **read it whole** (`regenerateIndex` parsed and schema-validated the entire chain to stamp one field into `context.yaml`) and **wrote it whole** (sealing loaded the chain, pushed one checkpoint, and dumped it back with an fsync). Cost per write was O(chain size), so cumulative cost was quadratic — and on a network-backed mount the fsync re-uploaded the entire file each time. Read paths never touch it, which is why only writes degraded.

- `regenerateIndex` and the publish seal now take the chain's head through `readLatestCheckpoint()` — a small pointer file validated against the chain's size, a bounded tail read of the chain, then a full read only for a file too small to have a usable tail. None of the three grows with the chain.
- Sealing **appends** one checkpoint instead of rewriting the file. The bytes are identical either way: `yaml.dump({checkpoints: […]})` emits exactly `checkpoints:` followed by each item indented two spaces, which is what the append writes. Whole-file rewrites remain for the §7.3 rebuild.
- The pointer is a cache, never an authority. It is stamped with the chain file's size and mtime and rejected when either moves, so a rebuild, a restored backup or an append from another process invalidates it instead of mislinking. That is a staleness check, not a proof of identity — the chain's own hash linkage remains what `verify` checks.
- Reading the chain reports a state, not a nullable checkpoint: `absent`, `empty`, `head`, or `unreadable`, with any other I/O failure thrown. Only `unreadable` licenses the quarantine below. Collapsing those was a data-loss bug in its own right — a valid `checkpoints: []` would be renamed aside as corrupt, and on the network-backed mounts this change exists for, one flaky read would rename a healthy multi-megabyte chain aside and restart numbering at 1.

An unreadable integrity file no longer refuses the write, either. A torn `history.yaml` — a null-byte-padded interrupted write, a hand edit, a schema-invalid file — used to throw `CorruptHistoryError` out of every publish and every edit of that document, permanently, from every surface. The document was fine; only its ledger was unreadable, and there was no way for the author to get past it.

- `VersionManager.historyOrRepair()` moves an unreadable `history.yaml` aside as `history.corrupt-<ts>.yaml` and reports the document as having no history, so the current write restarts the chain from a fresh keyframe. The same policy now covers an unreadable `context_history.yaml`.
- Nothing is destroyed to do it. The quarantined bytes stay on disk, and numbering continues past every `v{N}` artifact already sealed there (`nextVersion` now consults the artifacts as well as the ledger), so no keyframe or diff is ever reused — `writeVersionArtifact`'s exclusive create remains the backstop.
- The break stays visible: the entry that begins the replacement chain carries a note saying so, `verify` still reports the gap, and the quarantined file names it.
- The pre-publish seed is skipped on that restart path. It exists to rescue a body with no artifact; after a quarantine every artifact is still on disk, and seeding would write `v{current}.md` at a number the old chain may already have sealed as a keyframe — throwing, and putting the author right back behind the corruption.

Behaviour change: publishing a document whose history is corrupt now succeeds by quarantining, where it previously failed with `CorruptHistoryError`. `storage.readHistory()` itself still throws — the resilience is in `VersionManager`, so the low-level reader stays honest for callers that need to know.
