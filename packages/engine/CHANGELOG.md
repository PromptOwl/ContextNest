# @promptowl/contextnest-engine

## 1.3.0

### Minor Changes

- bcb1d76: Complete the `core` namespace of the API catalog (7 → 15 ops) so all three surfaces (OSS MCP, CLI, Community MCP) can bind to it instead of hand-rolling operations. Added, each with a Zod input/output descriptor + an executor bound to existing engine primitives:

  - **Lifecycle:** `context_publish` (`publish_document`), `context_delete` (`delete_document`)
  - **History/audit:** `context_versions`, `context_reconstruct` (`read_version`), `context_verify` (`verify_integrity`)
  - **Manifest/read:** `context_overview` (`vault_info`), `context_init` (loads CONTEXT.md), `context_packs`

  Without these, Phase 2 bindings would still hand-roll delete/publish/history/verify/overview — defeating the convergence goal and failing the PRD's "an OSS agent config works unchanged against a Community server" criterion. All compose engine primitives (`publishDocument`, `deleteDocument`, `readHistory`, `reconstructVersion`, `verifyVaultIntegrity`, `readContextMd`, `readPacks`) — no new logic, no duplicated schemas.

- aab37ee: Add `publishDocuments()` — bulk publish for folder importers.

  Publishing a large nest folder one file at a time via `publishDocument` is O(N²): each call seals its own checkpoint, and every checkpoint re-scans the entire vault (`discoverDocuments` + `findAllHistories` + a rewrite of the growing `context_history.yaml`). `publishDocuments(storage, ids, opts)` does the per-doc version work with bounded concurrency but seals **one** checkpoint for the whole batch and regenerates the index **once** — collapsing N full-vault rescans into a single pass. Failure-isolated: a bad/rejected file is reported in `failed[]` and skipped; the rest still publish. `publishDocument` is unchanged.

  Also exposes this over the API catalog as the `context_import` core op — bulk create-and-publish from document payloads `{ documents: [{title, content, type?, tags?, folder?, metadata?}] }` → `{ created[], failed[] }`, composing on `publishDocuments` so every binding (agent/CLI/REST) gets one O(N) bulk-import tool. `core` namespace is now 16 ops.

- bcb1d76: Add `@promptowl/contextnest-engine/api` — the canonical operation catalog, so the CLI, MCP, and REST surfaces stop hand-rolling the same operations (API convergence Phase 1).

  - **Catalog (schemas)** — `core` namespace (`context_get` / `context_query` / `context_resolve` / `context_list` / `context_search` / `context_create` / `context_update`): Zod input/output + draft-07 JSON Schema (`inputJsonSchema` / `outputJsonSchema`). Canonical names are `context_*`; OSS legacy names (`read_document`, `resolve`, …) are captured as `aliases`. Schemas compose the engine's existing domain schemas — no duplication.
  - **Executable ops** — `createEngineApi().run(name, input, ctx)` is the single implementation, bound to the engine primitives (`GraphQueryEngine`, `NestStorage`, `publishDocument`). Ungated mechanics only: published-only search, index regeneration after publish, status/tag normalization, and `validateDocument` before write. Preserves the AGPL↔Commercial line — no governance policy in the engine.
  - **Extension framework** — `EngineExtension` generalizes the existing `RbacHook` bridge seam: consumers register new operations (governance/workflow/sync) and wrap every op with `authorize` (throw to deny) + `onResult`, without forking. `NAMESPACES` advertises the implemented set for MCP `initialize` / REST manifest discovery.

- fa6db64: Add consumer-facing seams so the community server and TheOwl stop hand-rolling engine-owned logic:

  - **Stewards format** — `parseStewards` / `serializeStewards` / `STEWARDS_FILENAMES` + types. Canonical marshalling for `stewards.yaml` (format only; enforcement stays with the consumer).
  - **Wiki-link plumbing** — `extractWikiLinks` / `buildWikiTitleIndex` / `resolveWikiSeeds` / `traverseWikiGraph`. Pure, **ungated** primitives for `[[Title]]` seed resolution + hop traversal (the eligibility gate stays with the consumer).
  - **Fix** — `serializeDocument` now drops `undefined`-valued frontmatter keys instead of throwing `[object Undefined]` (these arise from the engine's own `normalizeTags([]) → undefined`). Lets consumers delete their `safePublishDocument`-style workarounds.

  Hardening on the above seams:

  - `serializeStewards` now omits keys whose entry list is empty (e.g. `{ tags: { "#x": [] } }`), matching `parseStewards` so the round-trip is symmetric.
  - `parseStewards`' lenient fallback (used only when strict YAML rejects legacy comma-joined shorthand) now accepts any sub-key indentation, not just 2 spaces — 4-space / mixed-indent legacy files no longer silently drop entries.
  - `StewardRole` documented as the canonical set, not a runtime guarantee: the format-only parser preserves non-canonical role strings as authored, so consumers must not assume the union is exhaustive.
  - `serializeDocument`'s undefined-strip is documented as shallow (top-level frontmatter only); a nested `undefined` would still throw. No current parser path produces one.
  - `parseStewards`' lenient fallback now recovers an inline `version: N` instead of silently pinning legacy files to version 1 — symmetric with its role handling (no field is dropped just because strict YAML rejected the file's shorthand).

- 01780c5: Invalid input no longer surfaces as a Node.js crash. `ctx resolve "tag:"` printed a raw stack trace with internal file paths because the selector lexer/parser threw plain `Error`, which the CLI's top-level handler deliberately rethrew.

  - **Engine:** new `InvalidSelectorError` (`INVALID_SELECTOR`, §2) thrown by the selector lexer and parser in place of plain `Error`; `VersionManager.reconstructVersion` now throws coded `VERSION_NOT_FOUND` / `RECONSTRUCTION_FAILED` (§6). These were the only uncoded throws left in `packages/*/src`, so every engine failure now carries a `code`.
  - **API catalog:** `ERROR_CODES` gains `INVALID_SELECTOR`, `VERSION_NOT_FOUND`, `RECONSTRUCTION_FAILED`; `context_reconstruct` advertises the latter two and passes them through instead of flattening missing history into `VALIDATION_FAILED`; `context_query` / `context_resolve` advertise `INVALID_SELECTOR`.
  - **CLI:** the top-level handler renders _every_ error as a one-liner (`Error [CODE]: message`), including YAML syntax errors, fs failures, and genuine bugs. Stack traces are still available on demand via `CONTEXTNEST_DEBUG=1`. Exit code stays non-zero.

  Behavioral note for API consumers: `context_reconstruct` on a document with no version history now rejects with `VERSION_NOT_FOUND` rather than `VALIDATION_FAILED`.

- 230cb4d: Per-version change logs, and version numbering that can no longer graft a second chain onto a document's history.

  **Change logs move out of `history.yaml` into their own files.** A non-keyframe version is now stored as `v{N}.diff` beside the keyframes — the unified diff taking the previous version to this one, hunk headers included, so each file is readable on its own and applies with standard patch tooling. `history.yaml` keeps metadata only, which matters because it is rewritten whole on every version: inline patches made each edit cost O(total history). Reads are backward compatible — `reconstructVersion` falls back to the patch stored inline by older histories, so existing vaults need no migration. New APIs: `NestStorage.readDiff`/`writeDiff`, `VersionManager.getDiff` (one small file read, no chain replay), and `VersionManager.externalizeDiffs` to move inline patches into files as a tidy-up.

  `context_versions` gains an opt-in `include_diff` input and a matching optional `diff` field on each version entry. Off by default: a document with dozens of versions would otherwise return dozens of patches, which is a lot of tokens to push at an agent that only asked who edited what and when.

  **Version numbers now outrank the recorded history, not just frontmatter.** `publishDocument`, `publishDocuments`, and the approval commit path all derive the next version from `VersionManager.nextVersion`, which takes the max of the caller's hint and every version already in `history.yaml`. Numbering from frontmatter alone let a document whose frontmatter lagged its history — an imported or copied vault, a restored backup, a doc whose frontmatter was reset — reuse a live version number: duplicate entries, `v{N}.md` keyframes overwritten at the same number, and `reconstructVersion` failing on the first diff after the graft, which made every later version unreadable.

  Two recoveries for chains already in that state:

  - `createVersion` falls back to writing a keyframe when the previous version cannot be reconstructed, instead of storing a diff against content it cannot rebuild. A broken chain heals on its next edit rather than failing forever.
  - `VersionManager.repairLatestVersion` re-anchors a grafted chain's latest version on the live document and drops the graft tail, without adding a version or renumbering anything already recorded. Versions from before the graft stay unreadable — those bytes were overwritten and are gone.

  `verifyDocumentChain` takes an optional fourth `readDiff` callback so a non-keyframe entry's hash is still checked once its patch lives in a file; `verifyVaultIntegrity` pre-loads those bytes the same way it already pre-loads keyframes. A non-keyframe entry with neither a diff file nor an inline patch now surfaces as `content_hash_mismatch` rather than passing silently — unlike a missing keyframe, a missing diff breaks every version after it.

### Patch Changes

- 4ea253f: Fix a corrupt `history.yaml` taking down every vault-wide operation, and stop producing corrupt ones.

  Surfaced while dogfooding: `ctx publish` threw `YAMLException: null byte is not allowed in input` from inside `findAllHistories`. One zero-filled history file — the residue of an interrupted non-atomic write — aborted the whole crawl, and with it the checkpoint seal, `ctx verify`, and the §7.3 rebuild.

  - **`findAllHistories` no longer throws on an unparseable history file.** It skips it, the way `readHistory` already did. Skipping alone would be a silent pass, though: `verifyCheckpointChain` treats a missing history as "nothing to check", so a document with a torn history would have verified green. The method now takes an optional `onUnreadable(docId, reason)` callback; `verifyVaultIntegrity` and `ctx verify` use it to report a new `unreadable_history` integrity error (also added to the `context_verify` output schema). Schema-invalid histories, previously dropped without a word, are reported the same way.
  - **`history.yaml` and `context_history.yaml` are now written durably** — temp file, `fsync`, rename over the target — instead of a truncate-in-place `writeFile` that leaves a zero-filled file if the process dies between the metadata extend and the data flush. Limited to the two hash-chain files: they are the integrity anchors and a torn one is unrecoverable, unlike a regenerable index. Temp names are unique per write (a shared `{path}.tmp` would make concurrent writers collide on ENOENT — reachable via `rebuildCheckpointHistory`, which writes `context_history.yaml` outside `withCheckpointLock`), and the rename retries briefly on `EPERM`/`EACCES`/`EBUSY`, which Windows raises when another handle holds the destination.

  - **A corrupt history can no longer destroy the versions it indexes.** `readHistory` returned `null` for a corrupt file and for an absent one alike. Since `history.yaml` is rewritten whole rather than appended to, and every write path treats `null` as a brand-new document, publishing a document whose history had been corrupted replaced it with a two-entry history: the recorded versions vanished from the index, their keyframe/diff files were orphaned on disk, `reconstruct` could no longer reach them, and `verify` then reported the vault clean because the evidence was gone. Worse, the auto-seeded pre-publish snapshot rewrote `v{N}.md` at the current version, so an existing keyframe's bytes were replaced outright. `readHistory` now raises `CorruptHistoryError` for a present-but-unreadable file and reserves `null` for "no history yet", so publish stops before touching anything.
  - **Recording a version now appends to `history.yaml` instead of rewriting it.** The rewrite was the reason a bad read could erase entries at all: the file was serialized whole from an in-memory object, so whatever that object was missing, the file lost. `createVersion` now appends a single list item under `versions:` (O_APPEND + fsync) and never reopens the bytes of the versions already recorded, which makes "old versions cannot be dropped" a property of the format rather than a check some future caller has to remember. Full rewrite is retained only for the paths that genuinely mutate existing entries (`repairLatestVersion`, `externalizeDiffs`), and `writeHistory` now forces `versions` last so the list stays open at EOF for appending.
  - **Sealed version artifacts are now immutable.** `writeKeyframe`/`writeDiff` refuse to overwrite an existing `v{N}.md`/`v{N}.diff` (exclusive create, so concurrent writers cannot race past it) and raise `VersionArtifactExistsError` instead. A sealed version's bytes are hashed into `content_hash` and chained, so rewriting one destroys the only copy and breaks the chain. The two deliberate repair paths — `repairLatestVersion` re-anchoring an unreconstructable version, and the idempotent `externalizeDiffs` — opt in with `{ overwrite: true }`.

  Compatibility: `findAllHistories`'s new parameter is optional, so existing callers are unchanged, and `unreadable_history` is an additive output enum member — no consumer in the repo switches exhaustively on the error type. Two intended behavioural changes: a vault holding an unparseable or schema-invalid `history.yaml` now reports `valid: false` where it previously reported green (that document was never actually being verified), and reads/writes against such a document now raise `CorruptHistoryError` rather than silently behaving as if the document had no history.

## 1.2.1

### Patch Changes

- Harden checkpoint-chain integrity against torn seals, tamper, concurrent-publish races, and rebuild laundering. `publishDocument` now gathers the published-docs and history snapshots inside the checkpoint lock via `createCheckpointFromVault`, so a concurrent publish can no longer slip between two separate reads and leave a document missing from — or version-skewed within — the checkpoint it seals.

## 1.2.0

### Minor Changes

- Security & correctness hardening for the new id/lifecycle work: `normalizeDocumentId` now rejects `..` path-traversal segments at the single choke point every CLI/MCP path conversion flows through (a manipulated path can no longer escape the vault root); `parseDocument` defaults a missing `status` to `draft` so a doc with no status field is no longer visible in listings yet invisible to `query`/`resolve`; and `readDocument` reads exactly `${id}.md` (no silent root fallback) so an `update_document` can never split a node into a second file.

- Replace `status: superseded` with a four-value canonical set + alias normalization.

  **Canonical statuses:** `draft`, `pending_review`, `approved`, `published`, `rejected`.

  - `draft` — editable scratch, hidden by default, surfaces with `includeDrafts: true`.
  - `pending_review` — author submitted, reviewer not yet signed off. Hidden from LLM, visible to stewards.
  - `approved` — reviewer signed off; not yet live. Hidden from LLM retrieval.
  - `published` — only canonical status surfaced to LLM retrieval by default.
  - `rejected` — terminal hide. `publishDocument` throws `RejectedDocumentError` to prevent silent resurrection.

  **Aliases (case-insensitive)** normalize to canonical at parse/write time. Unknown values fall back to `draft`. Shipped map covers `cancelled`/`canceled`/`archived`/`abandoned`/`deprecated`/`removed` → `rejected`; `superseded`/`todo`/`pending`/`wip`/`new` → `draft`; `review`/`in_review`/`in-review`/`under_review`/`under-review`/`submitted`/`needs_review`/`needs-review`/`awaiting_review`/`awaiting-review` → `pending_review`; `ready`/`reviewed`/`accepted`/`signed_off`/`signed-off` → `approved`; `active`/`live`/`released`/`final`/`shipped` → `published`.

  **API additions:** `normalizeStatus`, `STATUS_ALIASES`, `isDraft`, `isPendingReview`, `isApproved`, `isRejected`, `RejectedDocumentError`.

  **Deprecations (kept for back-compat, never thrown post this release):** `SupersededDocumentError`, `isSuperseded`. `storage.discoverDocuments({ includeSuperseded })` is accepted as an alias for `{ includeRetired }`.

  Legacy `status: superseded` on disk is auto-normalized to `draft` at parse time — no data migration required.

  **Error-code rename (downstream-visible).** The publish-guard error now reports `code: "REJECTED_DOCUMENT"` (was `"SUPERSEDED_DOCUMENT"`). Downstream code that branches on the error code must update its check. The deprecated `SupersededDocumentError` class is still exported but is never thrown after this release. Safe because no version with `SUPERSEDED_DOCUMENT` was ever published to npm.

  **Spec:** `CONTEXT_NEST_SPEC.md` §1.5 + new §1.5.1 document the lifecycle + alias rules.

- Add a central vault registry (`~/.contextnest/config.yaml`) that maps short aliases to vault paths, resolved by a single `resolveVaultPath` precedence chain: explicit alias → `CONTEXTNEST_VAULT` (alias) → `CONTEXTNEST_VAULT_PATH` (path) → positional arg → local walk-up → registry default → cwd. Explicit sources throw on a bad value; persistent ones warn and fall through so a stale setting never locks the user out.

  New public exports: `addVault`, `removeVault`, `setDefaultVault`, `listVaults`, `resolveVaultPath`, `readRegistry`, `findLocalVault`, `isVaultRoot`, `getRegistryDir`, `getRegistryPath`, `ALIAS_PATTERN`, `normalizeDocumentId`, the `UnknownAliasError` class, and the `VaultRegistry` / `VaultRegistryEntry` types. Registry writes are atomic and owner-only, with a Windows `EPERM` copy fallback.

  `normalizeDocumentId` is the single source of truth for path→id normalization (a bare slug resolves into `nodes/`), and `readDocument` falls back to the vault root for a `nodes/<slug>` id so a node that lives at the vault root stays readable by its slug. Root-level `*.md` discovery now requires frontmatter before treating a root file as a node (structured layout only), so scaffold files (`CHANGELOG`, `CONTRIBUTING`, `LICENSE`, …) are no longer ingested as nodes.

## 1.1.1

### Patch Changes

- Patch release with reliability fixes for vault init and history crawl.

  **@promptowl/contextnest-cli**

  - `ctx init` now targets the current working directory instead of walking up to find an ancestor vault. Initializing a vault is always a "create here" operation; walking up could resolve to a stray ancestor `.context/config.yaml` (e.g. `~/.context/config.yaml`) and misresolve init to the wrong directory. The `CONTEXTNEST_VAULT_PATH` env override still wins.

  **@promptowl/contextnest-engine**

  - Harden `findAllHistories()` and `readPacks()` against unreadable directories. Both crawls now pass `suppressErrors: true` to `fast-glob` so a single permission-denied directory under the vault root no longer crashes checkpoint rebuild or pack loading.

  **@promptowl/contextnest-mcp-server**

  - Internal: picks up the engine reliability fixes above (no surface API change).

## 1.1.0

### Minor Changes

- Minor release: documentation and selector fixes.

  ### Engine

  - Selector lexer now supports the `tag:#X` atom (spec alias for `tag:X`), so hashtag-prefixed tag queries parse correctly.

  ### Docs

  - Updated README and package metadata (description, keywords) across the engine, CLI, and MCP server.

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
