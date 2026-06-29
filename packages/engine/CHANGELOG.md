# @promptowl/contextnest-engine

## 1.2.0

### Minor Changes

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
