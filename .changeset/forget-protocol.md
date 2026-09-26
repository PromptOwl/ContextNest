---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

The forget protocol: erase a node and keep `verify` passing (spec §6.3)

`ctx forget <path> --reason <code> [--requested-by <who>]` (MCP / API:
`context_forget`) erases a node's content from its whole history — every
keyframe, diff, archived PDF binary, staged suggestion and version note — while
keeping each version entry's `content_hash` and `chain_hash` unchanged and
marking it `tombstone: true`. Because a chain hash is computed from the content
hash, never from the content, every later entry and every checkpoint binding
still verifies: `ctx verify` treats a tombstoned entry as hash-only and reports
it under `tombstoned`, not as an error. The reason is a closed code
(`user_request | legal | retention_expiry | error`), never free text.

The live file becomes an empty stub with the new sixth status `forgotten`,
sealed as a keyframe version and a checkpoint. Every `contextnest://` URI for
the path — floating or pinned `@N` — resolves to that stub (status
`forgotten`, empty body), not to nothing. Forgotten nodes are excluded from
retrieval, search, listings and selectors unless `status:forgotten` is asked
for. `forgotten` cannot be set through create/update. Readers that predate it
normalize it to `draft`, which keeps the stub out of default retrieval.
Reconstructing a forgotten version fails with `VERSION_FORGOTTEN`.

Every forget appends a `document.forgotten` event to
`.versions/chain_events.yaml`: who, when, reason code, requested-by and which
versions, plus the erased content's hashes, never the content itself.
`ctx forget-log [path]` (`context_forget_log`) reads it back.

Anti-resurrection: that record refuses the forgotten content wherever it turns
up. Publishing or creating at a forgotten path, publishing a body whose checksum
matches an erased revision, and importing (`context_import` `files`) a
pre-forget live file, keyframe, diff, history or PDF are all refused
(`FORGOTTEN_DOCUMENT`), at the original path or under a new name. An import
that carries a `chain_events.yaml` has its forget records merged into the
receiving vault's log instead of overwriting it, and they are re-applied to any
pre-forget copy the receiving vault holds. A copied vault carries its
tombstones. `ctx verify` reports `forgotten_content_present` (erased content
back on disk) and `unrecorded_tombstone` (a tombstone or `forgotten` status no
recorded forget accounts for).

**`ctx delete` now leaves a tombstone.** `context_delete` (and the legacy
`delete_document` tool) still removes the file and its history, but it also
records a `document.forgotten` event with `mode: delete`, so republishing the
path or re-importing the deleted content is refused the same way. The new
`reason_code` / `requested_by` inputs (`--reason`, `--requested-by`) go on the
record. `purge: true` (`ctx delete --purge`) is the escape hatch: it deletes
with no tombstone, so the path and its old content can come back. Use it when
re-creating a node under the same name.

Not in this release: version-range forget (§6.3.2 re-keyframing), lineage
`review_required` flags (§6.3.4) and the `expires_at` / `retain_until` lifespan
keys (§6.3.5).
