---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
---

**An imported forget erases only a copy of what it forgot.**

- `context_import` re-applies an imported forget only to a pre-forget copy: a local document whose history, live text or live body carries content the forget erased. A forget record naming a document here that holds none of it is refused (reported under `.versions/chain_events.yaml`) and not logged — before, any document named by id was erased, so a caller who could import could erase what it could not forget.
- Imported forget records are logged as their own fields, never verbatim (a YAML alias chain in one used to expand into a log of hundreds of megabytes), and in one read and one write of the log, however many (5000 used to take minutes under the vault lock). `NestStorage.appendChainEvents` appends a batch; `ChainEventLog.appendBatch` uses it.
- `applyImportedTombstones` now returns `{ applied, refused }`.
- Version files (history, keyframes, diffs) are read only when they are regular files, opened without blocking and checked on the open handle: a FIFO in their place no longer hangs verify, reconstruct or update.
- A JATS reference DOI, and the CLI's vault alias and nest labels, are trimmed in linear time.
