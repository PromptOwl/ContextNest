---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
---

**An imported forget is applied only to a copy of what it forgot, and logged once.**

- `context_import` re-applies an imported forget only to a pre-forget copy: a local document whose live text, live body, or any sealed version carries content the forget erased. A record naming a document here that holds none of it is refused (reported under `.versions/chain_events.yaml`) and not logged. A record reusing the id of a logged event with a different record is refused too — the log is deduplicated by id, so it would have been applied with no audit record of its own. A record scoped to versions is recorded but not applied to a live document: the engine forgets whole documents.
- This is a correctness filter, not authorization: a record carrying hashes a reader can obtain (a document's own checksum) still passes. Which callers may import forget records is the host's to decide; the engine applies no forget tier here.
- Imported forget records are logged as their own fields, never verbatim (a YAML alias chain in one used to expand into a log of hundreds of megabytes), with only distinct `sha256:` hashes kept, and in one read and one write of the log, however many (5000 used to take minutes under the vault lock). An imported chain-event log whose YAML aliases expand it past its own size is refused whole. A forget record that cannot be logged as a valid event is refused, never applied unlogged; an unquoted YAML timestamp is logged as ISO. Rebuilding a copy's versions reads at most 64 Mi characters per history, budget or not. `NestStorage.appendChainEvents` appends a batch; `ChainEventLog.appendBatch` uses it.
- **Breaking (API):** `applyImportedTombstones` now returns `{ applied, refused }` instead of `string[]`, and `TombstoneIndex` carries `eventIds`.
- Version files (history, keyframes, diffs) are read only when they are regular files, opened without blocking and checked on the open handle: a FIFO in their place no longer hangs verify, reconstruct or update.
- A JATS reference DOI, and the CLI's vault alias and nest labels, are trimmed in linear time. A structure-rule format (regex or token pattern) is at most 200 characters; compiling a token pattern walked it from every `{`.
