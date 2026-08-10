# @promptowl/contextnest-cli

## 2.0.0

### Major Changes

- f6e7bcb: `context_import` publishes documents already in the vault, and reports progress

  Folder importers write files into the vault themselves — the file's path _is_
  its document id, and its frontmatter is already authored. Until now
  `context_import` could only create nodes from `title` + `content`, minting a new
  `nodes/<folder>/<slug>` id for each, so those importers fell back to looping
  `publishDocument` one document at a time. That loop is O(N²): every publish
  seals its own checkpoint, and every checkpoint re-scans the entire vault.

  `context_import` now takes an optional `ids` array alongside `documents`. Ids are
  published as-is, with paths and frontmatter untouched. Both modes feed one
  `publishDocuments` call, so a mixed batch still seals ONE checkpoint and
  regenerates the index ONCE.

  - `BulkPublishOptions.onProgress(done, total)` fires as each document settles,
    published or failed.
  - `OperationContext.onProgress` carries that sink to any operation. It lives on
    the context rather than in an operation's input because inputs must stay
    JSON-serializable for the MCP/REST wire; in-process callers supply it, wire
    transports leave it undefined.
  - `ctx publish --all` bulk-publishes every unpublished document in the vault
    through the operation, with a live counter.
  - The MCP server exposes `context_import` as its first catalog-driven tool —
    description and schema come from the engine descriptor, so the surface cannot
    drift from the CLI and Community ones.

  **Breaking (`context_import` output):** `created` is renamed to `published`, and
  `checkpoint` is added. `failed` entries now carry `id` (for the `ids` path) _or_
  `title` (for the `documents` path) instead of `title` unconditionally. The
  operation catalog shipped in 1.3.0 with no consumers on any surface, so nothing
  in-tree depended on the old shape.

- c86ba71: Opening a vault takes one call, and `context_overview` is gone

  `context_init` returned only `CONTEXT.md`, `context_overview` returned counts and
  a node list, and neither returned the vault's configuration — so an agent opening
  a vault made two round trips and still could not see the config. Meanwhile the
  `vault_info` alias sat on `context_overview`, an operation that returns none of
  what `vault_info` returns.

  `context_init` now answers both halves of "open this vault" in one call: its
  `CONTEXT.md` instructions, its configuration (name, description, declared MCP
  servers), its path, and what it holds — total, counts by type and status, and the
  tag set. The node list itself is opt-in behind `include_nodes` (with `limit`),
  because counts and tags answer most opening questions and a large vault's node
  list dwarfs them. `vault_info` now aliases this operation, which actually returns
  what that name promises.

  `context_overview` is **removed**. Everything it returned, `context_init` returns.

  `context_init` also counts retired nodes. It discovers with `includeRetired`, so
  `by_status` can report `rejected` at all — the manifest previously omitted a whole
  status rather than reporting zero, the same defect `context_list` carried.

  `context_init`, `context_verify` and `context_packs` are registered as MCP tools;
  `vault_info` and `verify_integrity` keep their exact behaviour and are deprecated
  in favour of the first two.

  New CLI command `ctx info` shows a vault's instructions, configuration and
  contents (`--nodes` to list them, `--json` for the raw payload). It is
  deliberately **not** called `ctx init`: that command _creates_ a vault, where this
  one opens an existing one — same word, opposite meaning.

  `ctx verify` deliberately does **not** move onto `context_verify`. It verifies
  each document chain itself and reports unreadable histories per document, which is
  strictly more than the operation's vault-level integrity check; routing it through
  the catalog would have lost that.

- c86ba71: `context_list`, `context_get` and `context_versions` become the shared browse path

  The CLI, the MCP server and Community each grew a private copy of "filter a
  document list", and each got a different subset of the rules right. The filter
  now lives in one place — a new exported `filterDocuments(docs, filters)` — which
  `context_list` wraps and which surfaces that filter a list they already hold can
  call directly.

  **Two bugs in `context_list`, both of which made a filter silently return
  nothing:**

  - `status: "rejected"` could never match. The executor discovered documents
    without `includeRetired`, so retired ones were dropped before the status
    filter ever saw them. The CLI and MCP server each worked around this
    privately.
  - `type` compared `frontmatter.type` literally, with no `document` default. The
    field is optional, so `type: "document"` skipped every document that omits it
    — which is most of them.

  Also fixed, and previously inconsistent between surfaces: a tag now matches with
  or without its leading `#` and regardless of case. Comparing a bare filter value
  against `#`-prefixed frontmatter tags is a filter that always returns empty,
  which is worse than one that errors.

  `context_list` additionally accepts an **array of types**, so a caller browsing a
  family of types (every runnable type, say) no longer has to list everything and
  re-filter. Two more inputs let a governed surface adopt the operation rather than
  keep its own copy of discovery:

  - `include_retired` keeps retired nodes when no status filter is given. There a
    rejected document is still something its stewards act on, not one removed from
    the vault.
  - `full` returns each node's whole frontmatter and body instead of a summary, for
    callers that go on to gate and render the documents and would otherwise have to
    read every file a second time.

  **An operation whose input carried a `.refine()` could not be exposed over MCP at
  all.** A refine makes the input a `ZodEffects`, which has no `.shape` — and that
  shape is exactly what a tool is registered from. The SDK accepted the undefined
  value and published a tool advertising **no parameters**, so a client had no way
  to know what to send; `context_versions` shipped that way. The selector schemas
  are plain objects now and `resolveId` raises the same `VALIDATION_FAILED` at
  execution time. A regression test asserts each catalog tool advertises its
  declared inputs, which the old "inputSchema is defined" check sailed past.

  **Reading a node from a flat-layout vault returned NOT_FOUND.** `resolveId`
  re-rooted a bare id under `nodes/`, so every id from a vault whose documents
  carry no such prefix pointed at a document that does not exist — the same fix
  `context_update` and `context_import` already took, now applied to every
  selector-based operation.

  An id is therefore taken **exactly as stored**: a bare slug is no longer
  re-rooted under `nodes/`, so a caller migrating from `read_document` (which did
  re-root) must pass the full id. A trailing `.md` and leading slashes are still
  stripped, since callers build ids from file paths and storage appends `.md`
  itself.

  `context_get` gains three inputs, each one a thing a surface previously had to
  bypass the operation to do: `include_raw` returns the exact stored bytes for
  callers that re-serve the file verbatim, `verify_checksum` detects drift on read,
  and `allow_rejected` returns a retired node instead of refusing — reading one is
  not the same as republishing it. It is registered as an MCP tool, with
  `read_document` deprecated in its favour.

  `ctx read` runs through it. `ctx list` gains `--limit` and now runs through the
  operation. `ctx history` runs
  through `context_versions` and gains `--diff`, which it could not do at all
  before. Both `context_list` and `context_versions` are registered as MCP tools;
  `list_documents` keeps its exact behaviour and is marked deprecated in favour of
  `context_list`. `context_versions` is a new capability there — nothing exposed
  version history before, since `read_version` answers a different question.

- c86ba71: `context_update` becomes the shared update path for every surface

  The operation could not rename a node, could not set a status, and always
  published — so no surface could adopt it, and the CLI, MCP server and Community
  each kept a private copy of "edit a document". The copies drifted, and one rule
  in particular ("a lifecycle status change is metadata, not a release") was
  hand-rolled identically in two places and absent from a third.

  `context_update` now accepts:

  - `title` as the **new** title. It was previously a way to _select_ the node to
    update — but every surface addresses a node by id or path and sends a title
    only to rename, so selecting by title served no caller and collided with the
    field they all wanted. Selection is by `id`.
  - `status` — a canonical lifecycle status (normalize aliases with
    `normalizeStatus` before calling).
  - `publish` — defaults to true, and to **false** when `status` names a
    non-published lifecycle value, because those are metadata transitions rather
    than content releases. An explicit value always wins. This is the rule the CLI
    and MCP server each carried privately.
  - `note` — recorded against the publish in version history.
  - `version` — an explicit version to stamp, for governed callers that assign
    version numbers themselves for a revision awaiting review. Ignored when
    publishing, which assigns its own.

  Output gains `status` and `checkpoint`, mirroring `context_create`.

  Three behaviour changes come with it:

  - **`tags` replaces rather than merges**, matching the CLI, the MCP server and
    `context_create`. A caller that wants the old merge sends the merged set.
  - **`metadata` treats a null value as "clear this key".** A merge alone gave
    callers no way to remove metadata at all: over a JSON wire an absent key is
    indistinguishable from "leave this alone".
  - **A rejected document is refused only when no `status` is given.** Naming a new
    status is how a caller revives one, which the MCP server already allowed and
    the operation previously blocked outright.
  - **A body edit drops the stored checksum before writing.** The checksum
    describes the published body, so an edit whose publish then fails used to
    leave a stale one on disk and the next verified read reported the document as
    externally modified. Frontmatter-only edits keep it — the checksum covers the
    body alone.

  **Bug fix — updating a flat-layout vault.** The operation re-rooted a bare
  document id under `nodes/`, which silently redirected every id from a vault whose
  documents don't carry that prefix. Ids are now vetted for traversal without being
  rewritten, and the storage layer resolves them for its own layout — the same fix
  `context_import` took for its `ids` input.

  `ctx update` and a new `context_update` MCP tool both run through that one path.
  `update_document` keeps its exact behaviour and registration (including its status
  aliases) and is now marked deprecated in favour of `context_update`, so existing
  MCP clients are unaffected.

### Minor Changes

- c86ba71: The rest of the core operations become the shared path

  Search, selector query, resolution, publish, delete and version reconstruction were the last core operations each surface still implemented privately. They now run through the catalog, which completes the core namespace.

  **A version that does not exist returned a different version's content.** Reconstruction starts at the nearest keyframe at or before the version asked for and replays change logs forward. Ask for a version the history does not contain and there is nothing to replay, so it returned the keyframe's content as though it were the version requested — silently, in the one place that must never give a silently wrong answer. It refuses now. This surfaced a regression test that had been passing on exactly that wrong content: it asked for version 2 of a document left at version 1 and matched on a title both versions share.

  Three operations gained what a surface needed before it could adopt them:

  - `context_query` takes `include_drafts`, for authoring surfaces where the point is finding the draft you are working on. Without it, adoption would have silently dropped `ctx query --include-drafts`.
  - `context_publish` takes a version-history `note` and returns the `chain_hash`, both of which `ctx publish` reports.
  - `context_delete` returns the deleted node's `title`, read before removal — after the delete there is nothing left to ask.

  Node summaries now carry `description` when the document has one.

  `ctx search`, `query`, `publish`, `delete` and `reconstruct` run through the catalog; `ctx search` gains `--limit`. Six more MCP tools are registered, with `search`, `resolve`, `publish_document`, `delete_document` and `read_version` kept, unchanged, and marked deprecated.

  Two commands deliberately stay on their own implementations, and the reason is worth recording. `ctx verify` checks each document chain and reports unreadable histories per document, which is strictly more than the vault-level integrity operation. And `ctx resolve` evaluates a selector and lists what matches — despite the shared word, that is not `context_resolve`, which returns full bodies within a token budget.

  `context_packs` also returns each pack's `includes` and `excludes`. Leaving them out made it a lossy view of what is on disk — a caller listing packs had to read the file itself to see what a pack actually selects. `ctx pack list` runs through the operation now.

- 228c060: Nests carry a description, and agents can list every registered nest

  An agent targeting a nest had only its alias to go on. Nests now carry a
  human-readable description that says what the nest is _for_, and there is an
  operation to enumerate them.

  - `context_nests` lists every nest in the central registry:
    `{}` → `{ nests: [{ alias, path, description?, isDefault, exists }] }`. It is
    the first **registry-scoped** operation in the catalog — it reads
    `~/.contextnest/config.yaml` rather than one vault, so it ignores its
    `OperationContext`. The MCP server exposes it as a catalog-driven tool.
  - `NestStorage.init()` takes an optional `description` and writes it into
    `.context/config.yaml` (spec §11.1), so `ctx init --description` now reaches
    the nest's own config and not just the registry entry. `ctx init` resolves its
    interactive description prompt before creating the vault, so a prompted value
    lands in the config too.
  - `setVaultDescription(alias, description?)` and `ctx vault describe <alias>
[description]` edit a registry description after the fact. Omitting the text
    (or passing blank) removes the key rather than storing `""`, so the nest's own
    config description takes over again.

  **Description precedence**, applied wherever nest metadata is surfaced: the
  registry entry's `description` (a machine-local label for _your_ alias), then
  the nest's own `.context/config.yaml` `description` (travels with the vault),
  then its `name`. Blank counts as unset at every tier.

  **Behavior change (`ctx vault list`):** `listVaults()` previously fell back to
  the config's `name`, skipping its `description` entirely. Vaults whose config
  carries a `description` now show it instead of their `name`.

- c86ba71: `context_create` becomes the shared create path for every surface

  The operation could only derive an id from title + folder, always published, and
  could not express a skill block — so no surface could actually adopt it, and the
  CLI and MCP server each kept a private copy of "create a document". Those copies
  drifted: the same action produced different version numbers depending on which
  one you used.

  `context_create` now accepts:

  - `id` — mint your own instead of deriving from title + folder.
  - `publish: false` — leave the node a draft, for governed callers whose writes
    must clear review before becoming retrievable.
  - `note` — recorded against the publish in version history.
  - the `skill` block fields (`trigger`, `inputs`, `tools_required`,
    `output_format`, `guard_rails`), without which the operation could not produce
    a valid `type: skill` node at all.

  Output gains `status` and `checkpoint`, and a created node now carries
  `updated_at` instead of rendering blank until its first edit.

  `ctx add` and a new `context_create` MCP tool both run through that one path.
  Surface-specific authoring niceties — heading and step templates, default skill
  triggers — stay with their surface. `create_document` keeps its exact behaviour
  and registration and is now marked deprecated in favour of `context_create`, so
  existing MCP clients are unaffected.

  **Vocabulary now covers what the ecosystem actually stores.** Adopting the shared
  create path made Community validate its documents against the engine schema for
  the first time, and three shapes it has always written turned out to be invalid:

  - `agent`, `artifact` and `table` join `NODE_TYPES`. Vaults holding them failed
    `ctx validate` even though every surface reads and writes them.
  - `TAG_PATTERN` accepts `:`, so namespaced tags (`#dept:engineering`) validate.
    Strictly a widening — every previously valid tag still matches. Note the
    selector lexer does not tokenize `:` inside a tag, so namespaced tags are not
    yet addressable in a query.
  - `context_create` accepts an initial `status`, for callers that create a node
    directly into a lifecycle state other than draft (only meaningful alongside
    `publish: false`).

  **Behaviour fix — new-document version numbering.** `ctx add` wrote
  `version: 1` into frontmatter and let publish bump it, so a brand-new document's
  history began at **v2 with no v1 keyframe**. Publish owns version assignment
  (spec §6); a newly created document is now v1. The MCP server already had this
  fix, the CLI did not. Existing documents are unaffected.

### Patch Changes

- 228c060: Reject `__proto__`, `constructor` and `prototype` as vault aliases

  `registry.vaults` is a plain object keyed by a caller-supplied alias, and
  `ALIAS_PATTERN` matched `__proto__`. Two consequences:

  - `vaults["__proto__"]` returns `Object.prototype` — truthy, so it slipped past
    the `if (!entry)` guards. Writing to that entry altered `Object.prototype` for
    the whole process.
  - `addVault("__proto__", path)` assigned through `vaults[alias] = entry`, which
    replaces the object's prototype rather than adding a key.

  Aliases are now validated at every mutating entry point (`addVault`,
  `removeVault`, `setDefaultVault`, `setVaultDescription`), and alias resolution
  (`--vault`, `CONTEXTNEST_VAULT`, the MCP positional argument) does an
  own-property lookup so a prototype member can never read back as a registered
  vault. Reported by CodeQL (`js/prototype-polluting-assignment`).

- Updated dependencies [f6e7bcb]
- Updated dependencies [c86ba71]
- Updated dependencies [228c060]
- Updated dependencies [c86ba71]
- Updated dependencies [228c060]
- Updated dependencies [c86ba71]
- Updated dependencies [c86ba71]
- Updated dependencies [c86ba71]
  - @promptowl/contextnest-engine@2.0.0

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
