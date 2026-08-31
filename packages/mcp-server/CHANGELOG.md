# @promptowl/contextnest-mcp-server

## 2.3.0

### Minor Changes

- a061c4a: Refuse unknown write parameters instead of silently dropping them, and accept `body`/`content` as aliases.

  A caller that misnamed a parameter — `content` where `update_document` takes `body` — got a success response for a write that never landed: zod's default object mode stripped the key, the handler saw no body, the version bumped, `updated_at` moved, and a checkpoint and chain hash were written over unchanged text. The only way to notice was to read the document back and compare.

  - `EngineApi.run()` now rejects any key an operation's input schema does not declare (`VALIDATION_FAILED`, naming the unknown keys and listing the accepted ones).
  - The MCP server registers every tool through `registerTool` with a strict ZodObject, so the schema it publishes (`additionalProperties: false`) is the one it enforces. Previously it advertised strictness and stripped instead.
  - `context_create` / `context_update` accept `body` as an alias for `content`, and `create_document` / `update_document` accept `content` as an alias for `body`. Two values that disagree are refused rather than resolved by preference.
  - `context_create`, `context_update`, `create_document` and `update_document` take a `description`. It is one of the three fields the metadata index matches on, so a node without one is markedly harder to retrieve; update clears it with an empty string, matching `metadata`'s null convention.
  - `list_documents` gains the `path` filter its canonical twin `context_list` has as `folder`, matching on segment boundaries.

  Also: make `type: source` nodes writable at all.

  `create_document` built a `skill:` block for skill nodes but had no `source` equivalent, and skipped `validateDocument` entirely. A `type: source` node was therefore written and published with no `source:` block — which §13 rule 9 requires, but only enforces on the way out. Every subsequent update then failed validation, with no parameter able to supply the missing field: the node was write-once, recoverable only by `delete_document`, which destroys its version history. `context_create` was better behaved (it validates, so it failed loudly) but source nodes were simply uncreatable there.

  - New `applyTypedBlocks` settles `source` and `skill` against a node's post-write `type` BEFORE anything is written, shared by `context_create`, `context_update`, `create_document` and `update_document`. Entering `source`/`skill` requires that block (rules 9 / 18); leaving it drops the old one (rules 17 / 19).
  - `context_create` and `create_document` take a `source` block; `create_document` now validates before the write, so an invalid create leaves nothing on disk.
  - `context_update` and `update_document` take `type`, `source`, `trigger`, `tools_required` and `output_format`, so a node broken by this bug can be repaired without losing its history, and a node can be re-typed with its block swapped in the same call.
  - `sourceMetaSchema` is exported, so the write operations accept a source block against the same shape frontmatter validation enforces.

- ca294a1: Vault-hosted skills: install a `type: skill` node into an agent harness

  A skill node can now be rendered as a Claude Code `SKILL.md`, a Cursor rule, a
  Codex skill, or raw markdown, and installed into the caller's project or home
  directory. `skill.trigger` becomes the harness's local matcher — the one field
  that must exist locally, since matching happens before anything can be fetched,
  so a skill node without a trigger is refused rather than given a guessed one.

  The default install writes a **loader**: the trigger plus an instruction to fetch
  the procedure from the vault at runtime. A loader cannot go stale because it
  never holds a copy. `mode: "full"` embeds an offline snapshot instead, and says
  out loud that the copy will drift.

  - New engine module `skills.ts` (`renderSkill`, `buildInstallManifest`).
  - New catalog operations `context_skill` and `context_skill_install`, which the
    MCP server registers automatically — 38 tools now.
  - New CLI commands `ctx skill <path>` and `ctx skill install <path> [--write]`.
    Writes land outside the vault, so they go through the same never-clobber guard
    and dry-run accounting as `ctx read --out`.
  - New `skills.bootstrap` key in `.context/config.yaml`, naming the skill that
    teaches an agent to use this vault. `context_init` returns it as
    `config.skill_bootstrap`.
  - Node bodies can write `{{server_alias}}` / `{{vault_id}}` / `{{node_path}}`
    instead of hardcoding an `mcp__…__` prefix that is only correct on one client.

### Patch Changes

- a061c4a: Refuse unknown keys inside nested write objects too, and let `context_import` carry typed blocks.

  The unknown-key guard added alongside the strict MCP tool schemas reads an operation's OUTER shape only, so nested objects went on silently stripping — the same failure it was written to stop, one level down. A bulk import saying `body` instead of `content` published a node with the wrong text; a `source` block with a typo'd `server` was written incomplete and sealed into the chain.

  - `importDoc` and `importFile` are strict. The `files[]` case was the sharper one: the executor writes `f.content ?? ""`, so a stripped key landed an EMPTY file and still counted itself in `written`.
  - The `source` parameter of `context_create`, `context_update`, `create_document` and `update_document` is strict at each call site. `sourceMetaSchema` itself stays lenient by design — it also parses documents already on disk, where an unrecognized key is a file to keep reading rather than a caller to refuse. Making the base strict would start failing existing vault files.
  - `context_import` accepts `description` and the typed-block fields (`source`, `trigger`, `tools_required`, `output_format`, `inputs`, `guard_rails`). `buildDraftNode` already forwarded them to `applyTypedBlocks`, but the schema dropped them first, so `type: source` and `type: skill` nodes could not be imported at all — import was the one write surface the source-node fix missed.
  - `metadata` stays permissive; arbitrary keys are its purpose.

  Also repairs two handlers mangled in the merge of the vault-lock and strict-schema branches: `create_document` and `update_document` had a block-bodied arrow around `lockedHandler(...)`, whose return value was therefore discarded — the tool resolved `undefined` and the write ran unawaited. Both are back to the concise form the other locked tools use.

## 2.2.1

### Patch Changes

- e247037: Pick up the checkpoint-chain write fix, and stop `ctx index` reading the whole chain.

  Both binaries compile the engine into `dist/` and declare it as a devDependency, so an engine-only release would leave installed copies still running the old code — the checkpoint fix reaches `ctx` and the OSS MCP server only when they are rebuilt and republished. Every write path in both already routes through `publishDocument` / `publishDocuments` / `storage.regenerateIndex()`, so no call-site change was needed for them to inherit it.

  `ctx index` was the one exception. It reimplements `regenerateIndex` inline and carried its own copy of the whole-chain read for a single field (`checkpoints.at(-1)`); it now takes the head through `readLatestCheckpoint()` like the engine does. One-shot rather than per-write, so it was never part of the timeout, but it is the same O(chain size) cost.

## 2.2.0

### Minor Changes

- Remote nests: point `ctx` at a nest served over MCP and use it like a local vault.

  The vault registry grows a top-level `remotes:` map — stdio or HTTP specs, env-ref-only auth, sharing one alias namespace with local `vaults:`. Older CLIs strip the unknown key and keep working. `resolveNest()` resolves an alias to either a local path or a remote spec at the documented precedence; `resolveVaultPath()` wraps it and fails with a clear local-only error when an alias points at a remote.

  `--vault <remote-alias>` then routes read and write commands through an MCP client (`connectRemoteNest()`, SDK loaded lazily) instead of the local engine, with JSON output shape-identical to the local path. Local-only commands fail fast on a remote alias rather than pretending to work, and an unreachable remote exits 3 naming the alias.

  The wire contract is the engine's canonical operation catalog, so the MCP server now binds every core op under its canonical `context_*` name with catalog-sourced schemas, keeps the legacy tool names as deprecated aliases, and returns catalog output shapes and structured `{code, message}` errors. That closes the drift between engine, CLI and MCP server on the remote path.

  Capability-aware behaviour on top of it:

  - `ctx publish` against a remote that has no `context_publish` routes through the remote's review flow instead of failing — Community publishes via steward review.
  - `ctx verify` refuses to report a verification the remote cannot perform, rather than fabricating a pass.

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

- Updated dependencies [f6e7bcb]
- Updated dependencies [c86ba71]
- Updated dependencies [228c060]
- Updated dependencies [c86ba71]
- Updated dependencies [228c060]
- Updated dependencies [c86ba71]
- Updated dependencies [c86ba71]
- Updated dependencies [c86ba71]
  - @promptowl/contextnest-engine@2.0.0

## 1.2.1

### Patch Changes

- Bump `@modelcontextprotocol/sdk` to `^1.29.0`.

- Updated dependencies []:
  - @promptowl/contextnest-engine@1.2.1

## 1.2.0

### Minor Changes

- Support the new document status lifecycle (`draft`, `pending_review`, `approved`, `published`, `rejected`) and its case-insensitive aliases. `update_document` and `list_documents` accept alias values (e.g. `active`, `cancelled`, `superseded`) and persist/filter on the canonical value; the `document_format` tool returns the full alias map.

### Patch Changes

- Resolve the served vault through the engine's vault registry: honor the `CONTEXTNEST_VAULT` alias and the documented resolution precedence (alias → path → positional arg → local walk-up → registry default → cwd). A bad alias or non-vault path now produces a clean error on stderr at startup instead of an unhandled stack trace. A relative positional vault-path argument (`contextnest-mcp ./vault`) resolves against the working directory again.

  The mutation and read tools (`read_document`, `read_version`, `update_document`, `delete_document`, `publish_document`) now normalize a bare path into `nodes/` consistently with `create_document`, so a document created via MCP is reachable by the same path.

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
