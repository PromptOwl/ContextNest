# @promptowl/contextnest-cli

## 1.2.2

### Patch Changes

- 230cb4d: `ctx verify` reads each version's change log from its own file, so non-keyframe entries are hash-checked again now that patches live beside the keyframes rather than inside the history index. Without this, verify reported a mismatch for every version that carried a patch.

  `ctx add` refuses a path that already holds a document, with `DOCUMENT_EXISTS`, and leaves the existing file untouched. It previously failed only by accident: the template it writes resets the version to 1, which collided with a number already in the chain and blew up during publish — after the original bytes had already been overwritten.

- 4ea253f: Fix a corrupt `history.yaml` taking down every vault-wide operation, and stop producing corrupt ones.

  Surfaced while dogfooding: `ctx publish` threw `YAMLException: null byte is not allowed in input` from inside `findAllHistories`. One zero-filled history file — the residue of an interrupted non-atomic write — aborted the whole crawl, and with it the checkpoint seal, `ctx verify`, and the §7.3 rebuild.

  - **`findAllHistories` no longer throws on an unparseable history file.** It skips it, the way `readHistory` already did. Skipping alone would be a silent pass, though: `verifyCheckpointChain` treats a missing history as "nothing to check", so a document with a torn history would have verified green. The method now takes an optional `onUnreadable(docId, reason)` callback; `verifyVaultIntegrity` and `ctx verify` use it to report a new `unreadable_history` integrity error (also added to the `context_verify` output schema). Schema-invalid histories, previously dropped without a word, are reported the same way.
  - **`history.yaml` and `context_history.yaml` are now written durably** — temp file, `fsync`, rename over the target — instead of a truncate-in-place `writeFile` that leaves a zero-filled file if the process dies between the metadata extend and the data flush. Limited to the two hash-chain files: they are the integrity anchors and a torn one is unrecoverable, unlike a regenerable index. Temp names are unique per write (a shared `{path}.tmp` would make concurrent writers collide on ENOENT — reachable via `rebuildCheckpointHistory`, which writes `context_history.yaml` outside `withCheckpointLock`), and the rename retries briefly on `EPERM`/`EACCES`/`EBUSY`, which Windows raises when another handle holds the destination.

  - **A corrupt history can no longer destroy the versions it indexes.** `readHistory` returned `null` for a corrupt file and for an absent one alike. Since `history.yaml` is rewritten whole rather than appended to, and every write path treats `null` as a brand-new document, publishing a document whose history had been corrupted replaced it with a two-entry history: the recorded versions vanished from the index, their keyframe/diff files were orphaned on disk, `reconstruct` could no longer reach them, and `verify` then reported the vault clean because the evidence was gone. Worse, the auto-seeded pre-publish snapshot rewrote `v{N}.md` at the current version, so an existing keyframe's bytes were replaced outright. `readHistory` now raises `CorruptHistoryError` for a present-but-unreadable file and reserves `null` for "no history yet", so publish stops before touching anything.
  - **Recording a version now appends to `history.yaml` instead of rewriting it.** The rewrite was the reason a bad read could erase entries at all: the file was serialized whole from an in-memory object, so whatever that object was missing, the file lost. `createVersion` now appends a single list item under `versions:` (O_APPEND + fsync) and never reopens the bytes of the versions already recorded, which makes "old versions cannot be dropped" a property of the format rather than a check some future caller has to remember. Full rewrite is retained only for the paths that genuinely mutate existing entries (`repairLatestVersion`, `externalizeDiffs`), and `writeHistory` now forces `versions` last so the list stays open at EOF for appending.
  - **Sealed version artifacts are now immutable.** `writeKeyframe`/`writeDiff` refuse to overwrite an existing `v{N}.md`/`v{N}.diff` (exclusive create, so concurrent writers cannot race past it) and raise `VersionArtifactExistsError` instead. A sealed version's bytes are hashed into `content_hash` and chained, so rewriting one destroys the only copy and breaks the chain. The two deliberate repair paths — `repairLatestVersion` re-anchoring an unreconstructable version, and the idempotent `externalizeDiffs` — opt in with `{ overwrite: true }`.

  Compatibility: `findAllHistories`'s new parameter is optional, so existing callers are unchanged, and `unreadable_history` is an additive output enum member — no consumer in the repo switches exhaustively on the error type. Two intended behavioural changes: a vault holding an unparseable or schema-invalid `history.yaml` now reports `valid: false` where it previously reported green (that document was never actually being verified), and reads/writes against such a document now raise `CorruptHistoryError` rather than silently behaving as if the document had no history.

- 01780c5: Invalid input no longer surfaces as a Node.js crash. `ctx resolve "tag:"` printed a raw stack trace with internal file paths because the selector lexer/parser threw plain `Error`, which the CLI's top-level handler deliberately rethrew.

  - **Engine:** new `InvalidSelectorError` (`INVALID_SELECTOR`, §2) thrown by the selector lexer and parser in place of plain `Error`; `VersionManager.reconstructVersion` now throws coded `VERSION_NOT_FOUND` / `RECONSTRUCTION_FAILED` (§6). These were the only uncoded throws left in `packages/*/src`, so every engine failure now carries a `code`.
  - **API catalog:** `ERROR_CODES` gains `INVALID_SELECTOR`, `VERSION_NOT_FOUND`, `RECONSTRUCTION_FAILED`; `context_reconstruct` advertises the latter two and passes them through instead of flattening missing history into `VALIDATION_FAILED`; `context_query` / `context_resolve` advertise `INVALID_SELECTOR`.
  - **CLI:** the top-level handler renders _every_ error as a one-liner (`Error [CODE]: message`), including YAML syntax errors, fs failures, and genuine bugs. Stack traces are still available on demand via `CONTEXTNEST_DEBUG=1`. Exit code stays non-zero.

  Behavioral note for API consumers: `context_reconstruct` on a document with no version history now rejects with `VERSION_NOT_FOUND` rather than `VALIDATION_FAILED`.

- Updated dependencies [bcb1d76]
- Updated dependencies [aab37ee]
- Updated dependencies [bcb1d76]
- Updated dependencies [fa6db64]
- Updated dependencies [4ea253f]
- Updated dependencies [01780c5]
- Updated dependencies [230cb4d]
  - @promptowl/contextnest-engine@1.3.0

## 1.2.1

### Patch Changes

- Pick up `@promptowl/contextnest-engine@1.2.1` (checkpoint-chain integrity hardening). No CLI behavior change.

## 1.2.0

### Minor Changes

- Support the new document status lifecycle (`draft`, `pending_review`, `approved`, `published`, `rejected`) and its case-insensitive aliases. `ctx update --status` and `ctx list --status` accept alias values (e.g. `active`, `cancelled`, `superseded`) and persist/filter on the canonical value; unknown values fall back to `draft`. `ctx index` rewrites any aliased on-disk status to canonical.
- Add a `ctx vault` command group (`list`, `add`, `remove`, `default`, `which`) and a global `--vault <alias>` selector usable before or after any subcommand, so any registered vault can be targeted from any directory. Resolution is delegated to the engine's central registry; `ctx vault which` reports which vault would be used and why.

  A document created by a bare slug (`ctx add foo` → `nodes/foo`) is now reachable by that same slug from every command (`read`, `publish`, `update`, `delete`, `history`, `validate`, `reconstruct`) — previously only `add` normalized into `nodes/` while the others looked at the vault root, so the document was unreachable by its slug.

### Patch Changes

- Normalize space-separated `--tags` input (e.g. `--tags "#cmd #analyze"`) into discrete tags in `ctx add` and `ctx update`, matching the existing comma-separated behavior.
- Updated dependencies:
  - @promptowl/contextnest-engine@1.2.0

## 1.1.1

### Patch Changes

- Patch release with reliability fixes for vault init and history crawl.

  **@promptowl/contextnest-cli**

  - `ctx init` now targets the current working directory instead of walking up to find an ancestor vault. Initializing a vault is always a "create here" operation; walking up could resolve to a stray ancestor `.context/config.yaml` (e.g. `~/.context/config.yaml`) and misresolve init to the wrong directory. The `CONTEXTNEST_VAULT_PATH` env override still wins.

  **@promptowl/contextnest-engine**

  - Harden `findAllHistories()` and `readPacks()` against unreadable directories. Both crawls now pass `suppressErrors: true` to `fast-glob` so a single permission-denied directory under the vault root no longer crashes checkpoint rebuild or pack loading.

  **@promptowl/contextnest-mcp-server**

  - Internal: picks up the engine reliability fixes above (no surface API change).

- Updated dependencies []:
  - @promptowl/contextnest-engine@1.1.1

## 1.1.0

### Minor Changes

- Minor release: documentation and selector fixes.

  ### Engine

  - Selector lexer now supports the `tag:#X` atom (spec alias for `tag:X`), so hashtag-prefixed tag queries parse correctly.

  ### Docs

  - Updated README and package metadata (description, keywords) across the engine, CLI, and MCP server.

### Patch Changes

- Updated dependencies []:
  - @promptowl/contextnest-engine@1.1.0

## 1.0.0

### Major Changes

- # v1.0 — Governance, Integrity & Multi-Zone Security

  First stable major. Transforms ContextNest from direct-write doc store
  into governed, auditable, security-aware knowledge platform.

  ## Breaking changes

  ### Suggestion workflow (engine + CLI + MCP)

  Direct writes replaced by `stage → approve / reject` flow.

  New engine APIs:

  - `stageSuggestion`, `listSuggestions`, `readSuggestion`
  - `approveSuggestion`, `rejectSuggestion`, `quarantineSuggestion`
  - `rollbackDocument`, `czarDirectEdit`

  New CLI commands:

  - `contextnest stage <path>`
  - `contextnest list <path>`
  - `contextnest approve <path> <suggestionId>`
  - `contextnest reject <path> <suggestionId>`

  MCP server exposes equivalent tools.

  ### RBAC enforcement

  - New `RbacHook` interface gates governance actions.
  - Production must supply real hook + actor metadata.
  - CLI ships permissive local stub.

  ### Per-document hash chain

  Every mutation appended to `ChainEventLog` via `HashChainEvent`.

  Integrity APIs:

  - `detectDrift`, `verifyRemoteDelta`
  - Checkpoint drift validation
  - `UNSTAGED_DRIFT_SENTINEL`

  New error types:

  - `ChainBreakError`, `ZoneChallengeError`
  - `QuarantineError`, `UnauthorizedActionError`

  ### Classification & multi-zone

  - Classification manifest parsing
  - `classifyDocument`, zone challenge detection
  - New types: `GovernanceTier`, `SuggestionSource`, `PendingChange`, `SuggestionMeta`

  ### Storage / indexing

  - `NestStorage.regenerateIndex()` centralizes index regeneration.
  - CLI + MCP delegate to engine API.
  - `NestStorage.readDocument` accepts options.

  ## Other

  - `runHygienistScan()` for vault hygiene checks.
  - ReDoS hardening in `classification.ts`.
  - Wide test coverage: approval, chain log, classification, RBAC,
    suggestions, drift, integration paths.

  ## Migration

  1. Replace direct writes with `stageSuggestion` + `approveSuggestion`.
  2. Use `czarDirectEdit` only for trusted admin edits.
  3. Implement production `RbacHook`.
  4. Run `verify` + checkpoint after upgrade.
  5. One-time integrity pass on existing vaults if needed.

### Patch Changes

- Updated dependencies []:
  - @promptowl/contextnest-engine@1.0.0
