---
"@promptowl/contextnest-engine": minor
---

Serialize concurrent vault writes behind a per-vault lock.

Every mutating operation read-modify-writes the nest-level
`.versions/context_history.yaml` hash chain. With nothing serializing that,
concurrent writers corrupted it *silently* — measured with 6 parallel
`ctx update` processes on one vault: all bodies landed, 3 checkpoint seals were
lost, and `ctx verify` then reported `cross_chain_mismatch`. Reachable with two
terminals today; guaranteed once parallel agents write the same vault.

- New `vault-lock.ts`, exported as `withVaultLock`, `VaultLockTimeoutError` and
  `LOCK_DIRNAME`. The mechanism is `mkdir` of `<root>/.versions/.lock` — atomic
  on POSIX and Windows alike, no open file handle. Writers acquire with jittered
  bounded backoff; reads never lock.
- A holder heartbeats while its critical section runs, so a live writer is never
  judged stale however long the write takes. Only a holder that stops
  heartbeating (a crashed process) goes stale and is stolen, and each
  acquisition writes an owner token so a stolen holder cannot delete the next
  writer's live lock on its way out.
- Every mutating core executor and the four approval-path entry points
  (`approveSuggestion`, `rejectSuggestion`, `rollbackDocument`,
  `czarDirectEdit`) run inside the lock.
- New `VAULT_LOCK_TIMEOUT` error code on the affected core operations, returned
  when the lock cannot be acquired within the bound. **Callers that map engine
  error codes need an entry for it.**

Out of scope, so the boundary stays explicit: several server *instances* over
shared object storage (a filesystem lock cannot span that; the upgrade path is
optimistic concurrency on the chain's parent `chain_hash`), and a vault inside a
Dropbox/iCloud-synced folder edited from two machines.
