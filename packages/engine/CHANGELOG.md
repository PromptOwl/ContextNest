# @promptowl/contextnest-engine

## 2.1.0

### Minor Changes

- 6b6ffcb: Flatten the dependency tree and publish the dependency graph.

  Installing the CLI now pulls **2 packages with no nesting** (1 with `--omit=optional`), down from 104 packages at depth 7. **The MCP server installs nothing at all**, down from 97 packages at depth 11.

  The CLI and MCP server are binaries, not libraries, so their dependencies are now compiled into `dist/` and declared as devDependencies. Unused code is dropped in the process — the MCP server no longer ships the SDK's express, hono, ajv and jose transports, none of which a stdio server touches. Every bundled package is listed with its version and licence in `DEPENDENCIES.md`, so nothing is hidden by being bundled.

  The engine is a library and keeps real dependencies — 7 packages at depth 2, down from 76. Four were removed outright without losing any behaviour:

  - `unified` / `remark-parse` / `remark-gfm` (58 packages) — the markdown AST was used only to find `contextnest://` links and section headings, which a fence-aware line scanner does directly.
  - `fast-glob` (18 packages) — replaced by a small `*` / `**` matcher over a `readdir` walk.
  - `gray-matter` (11 packages) — frontmatter is split in-tree and parsed with the `js-yaml` the engine already depended on, instead of a second, older copy of it.
  - `cli-table3` (7 packages) — declared but never imported.

  Alongside that:

  - **No install scripts.** The CLI's `postinstall` banner is gone; installing the package now executes none of our code. The same guidance is one `ctx` away in the top-level help.
  - **Minimal install profile.** `chalk` moved to `optionalDependencies`, so `npm install -g @promptowl/contextnest-cli --omit=optional` installs a colour-free CLI — a single package — with every command, flag and output format unchanged.
  - **Published dependency graph.** `DEPENDENCIES.md` records every installed and bundled package, why it is there, and its licence. CI regenerates it and fails on drift, verifies that every module a published bundle imports is a declared dependency, and uploads the machine-readable graph as a build artifact.

- 0610438: Give `context_import` the whole folder-import flow, instead of half of it.

  Importing an existing vault took two passes over every document before
  publishing even started. The importer scanned the vault itself, rewrote each
  file to stamp its own metadata (an `author` that is the importing user, a title
  falling back to the filename), and only then handed the ids back to be
  published — which rewrites each file again. On a network-backed mount that is
  two extra round trips per document, and the scan is duplicated work the engine
  had already done.

  Three additions close that gap:

  - `files[]` writes an existing vault's files in **verbatim**, at their own
    relative paths. Nothing is synthesized, so the source's frontmatter survives
    (`version`, `checksum`, custom keys a generated draft would drop), and files
    that are not documents travel too — `.versions/<doc>/history.yaml` included,
    which is what lets an imported version chain still reconstruct. Paths are
    guarded: `..` and absolute paths are rejected per-file rather than aborting
    the import.
  - `publish: false` stages files without publishing them. An upload that arrives
    in several batches can stage every batch and publish once at the end, so the
    import seals ONE checkpoint rather than one per batch.
  - `discover: true` makes the vault itself the input. The engine scans, decides
    publish-vs-hold from each file's own frontmatter, publishes the batch under a
    single checkpoint, and returns a record per document (`id`, `title`,
    `version`, `status`, `tags`, `content`) — enough for a governance layer to
    record the import without re-reading the vault. `exclude_ids` skips what an
    earlier run already took, so a re-import is idempotent.

  **Publishing is opt-in.** Only a document whose frontmatter explicitly says
  `published` or `approved` gets published. Everything else is held as a draft,
  including a document that states no status at all — saying nothing is not
  consent. A vault of hand-authored notes carries no governance state, and
  importing it should not decide on the author's behalf that every note is fit to
  serve to an AI. Held is recoverable, since you can approve what belongs;
  published-by-default is not, because the exposure has already happened by the
  time anyone reviews it. A held document is stamped with an explicit
  `status: draft` rather than left implied, so a file read outside the engine is
  never ambiguous — except where the author already stated `pending_review` or
  `rejected`, which is theirs to keep.

  The metadata stamp now rides along with the publish write through a new
  `frontmatter` hook on `publishDocuments`, so it costs no pass of its own.

  Two supporting pieces:

  - `parser.explicitStatus(node)` returns the status the author actually wrote, or
    `null`. `parseDocument` defaults a missing `status` to `draft`, so
    `frontmatter.status` cannot tell a deliberate draft from a status-less
    hand-authored note. Import needs that distinction: a status-less file is fair
    game to publish, an explicit `draft` or `pending_review` must stay
    unpublished. Aliases are normalized first, so an import cannot slip a
    not-yet-approved document past the hold by spelling its status differently.
  - `storage.writeVaultFile(relPath, content)` writes a file into the vault
    verbatim under a path-traversal guard, parsing nothing.

### Patch Changes

- 6147ce4: Read the whole-vault crawls in parallel batches instead of one file at a time.

  `discoverDocuments`, `findAllHistories` and the per-folder `INDEX.md` writes in
  `regenerateIndex` each walked their files with an `await` inside a loop. On a
  local disk that is free; on a network-backed vault mount every read is a round
  trip, so a crawl cost one latency per file — and a bulk publish runs three such
  crawls, which is what made importing a few hundred documents take minutes.

  Batching overlaps those round trips. Ordering and error handling are unchanged:
  documents still come back sorted by id, and an unreadable history is still
  skipped and reported through `onUnreadable` exactly once.

  Bulk publish already batched its per-document work through its own sliding
  window; both now share one helper, so there is a single implementation of
  "bounded-parallel map, preserving order". Publish keeps its own (lower) default
  and its caller-configurable `concurrency` option — its unit is a document, each
  costing several file operations, so the two bounds describe different amounts of
  in-flight I/O.

- c18b730: Reject titles and ids that carry no usable characters

  A title of `###`, `...`, `!!!` or spaces slugifies to nothing. `context_create` already refused it, but a server that derives the id itself and calls the storage primitives directly went straight through: the document was written to `nodes/.md`, a dotfile discovery never lists, no id can address, and the next symbols-only title collided with. The write reported success and left a document nobody could open or delete.

  - `assertSafeDocumentId` — which `normalizeDocumentId`, `publishDocuments` and the update path all funnel through — now rejects any path segment with no letter or number, alongside the existing `..` traversal check. The rule is `\p{L}`/`\p{N}`, not the a-z0-9 slug rule, because existing ids are read back through the same guard and a vault may legitimately hold `nodes/日本語`.
  - `context_update` now rejects a supplied `title` with no letter or number in any script. A rename leaves the id alone, so this is the `\p{L}`/`\p{N}` rule rather than create's a-z0-9 slug rule — a document created with an explicit id may legitimately be titled `日本語`, and it stays renameable.

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
