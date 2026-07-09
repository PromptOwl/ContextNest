# Plan: Proprietary Governance Package (RBAC + Provenance + Read/Commit Gates) in the ContextNest Monorepo

Date: 2026-07-06 · Branch: `Qaish-Kanchwala/CU-wdqcpzutcj/Create-an-agent-with-hooks-for-claude-code`

## Context

The proprietary RBAC/governance implementation ("mem gate standards") currently lives in the **private** repo `contextnest-community` (commercial license, imports `@promptowl/contextnest-engine`). Its "stewardship" system resolves per-user × per-nest × per-scope roles, gates reads and commits at the HTTP/MCP layer, and records provenance — while injecting an all-`true` `RbacHook` stub into the engine. The engine itself (public repo `PromptOwl/ContextNest`, AGPL-3.0) has ungated reads, queries, CRUD, and publish.

**Decisions (user-confirmed):**

- Adopt the open-core monorepo model (GitLab-EE style): governance code moves into this public repo as `packages/governance/` under its own **commercial license** — source-visible but legally proprietary (PromptOwl owns the engine copyright, so AGPL-adjacent proprietary code is fine).
- Port scope: **everything** — stewardship service, access guard, access.yaml service, and the `api_events` trace-log provenance store.
- `packages/governance` is **never published to npm**; only the AGPL packages keep releasing.
- The community server (auth, license gate, SSO, UI) **stays in its private repo** and will later consume the governance package via a git dependency.

## Part A — Engine seams (`packages/engine/`, stays AGPL, identity-agnostic)

- **`GovernanceHooks extends RbacHook`** — adds optional `canRead(actor, target)` and `canCommit(actor, target, operation)` where `target = {documentId, zone?}`, `operation = "create"|"update"|"delete"|"publish"|"stage_suggestion"`. Absent hook/method = **allow** (backward compat; reads/commits are ungated today). Existing approve/reject/rollback/czarDirectEdit semantics unchanged; every existing `RbacHook` remains valid.
- **Provenance**: `ProvenanceOrigin {client?, tool?, session_id?, agent?}`, `ProvenanceRecord`, `ProvenanceRecorder` sink. Additive `origin?` on `VersionEntry`, `HashChainEvent`, `AccessTrace`. **Verified safe**: `computeChainHash` (`packages/engine/src/integrity.ts:52-62`) hashes only `prev:content_hash:version:edited_by:edited_at` — `origin` is stored-but-unhashed, existing chains unaffected. Do NOT touch `Checkpoint` (`triggered_by` is hashed). Recorder failures swallowed (`recordProvenance` in new `provenance.ts`).

Module changes:

1. `types.ts` — new types above + `GovernanceBundle {hooks?, recorder?}`; `governance?: {module?: string}` on `NestConfig`.
2. `schemas.ts` — `provenanceOriginSchema`; wired into `versionEntrySchema`, `hashChainEventSchema`, `suggestionMetaSchema`, `nestConfigSchema` (zod strips unknown keys → old engines still parse).
3. `rbac.ts` — add `denyAllGovernance`, `allowAllGovernance`, `requireRead()`, `requireCommit()` (throw `UnauthorizedActionError`), `filterReadable<T extends {id}>()` (silent filter; mirrors community `filterAccessible` shape).
4. `versioning.ts` — `createVersion` options gain `origin?`; hash inputs byte-identical.
5. `publish.ts` — `PublishOptions` gains `zone?/governance?/origin?/recorder?`; `requireCommit(..., "publish")` before mutation; provenance record after checkpoint.
6. `storage.ts` — per-call opt-in gates only (indexing/integrity/checkpoints/`discoverDocuments` untouched): `readDocument` throws on deny, `readDocuments` filters, `writeDocument`/`deleteDocument` gate.
7. `graph-query-engine.ts` — `GraphQueryOptions` gains `actor?/governance?/origin?/recorder?`; **filter post-traversal** (checks only reached set; denied nodes may still bridge hops, content never loaded; `nodesTraversed` keeps meaning — TSDoc). Same in `fullQuery`. `tracing.ts` gains actor/origin on `logAccess`.
8. `chain-log.ts` — constructor gains `{recorder?}`; mirror events after persistence.
9. `approval.ts` — widen `BaseInput.rbac` to `GovernanceHooks`; thread `origin?/recorder?`. `suggestions.ts` — gate staging with `requireCommit(..., "stage_suggestion")`, `origin` on `suggestionMetaSchema`. `hygienist.ts` — type widen only.
10. `governance-loader.ts` (new) — `loadGovernanceBundle()`: precedence explicit option → `CONTEXTNEST_GOVERNANCE_MODULE` env → `NestConfig.governance.module`; module exports `createGovernance(ctx) => GovernanceBundle`; malformed → `ConfigError` (fail loud). Relative paths resolve against vault path.
11. `index.ts` barrel — export all new types/helpers/loader/schema.

## Part B — New proprietary package `packages/governance/`

**Identity**: `@promptowl/contextnest-governance`, `"license": "SEE LICENSE IN LICENSE.md"`, `"private": true`. `LICENSE.md` adapted from contextnest-community's "Commercial Software License" (Promptowl LLC). Depends on `@promptowl/contextnest-engine: workspace:^` and `better-sqlite3` (+ `pg` if the community db abstraction ports cleanly; otherwise SQLite first, pg in a follow-up).

**Licensing mechanics for the monorepo**:

- Root `LICENSE` stays AGPL-3.0; add a root `NOTICE` (or LICENSE preamble + README section): "All code AGPL-3.0 **except** `packages/governance/`, which is commercial — see packages/governance/LICENSE.md."
- Update README license section to describe the split.
- Short license header comment in each `packages/governance/src/*.ts` file.

**Ported modules** (source: contextnest-community; decouple from Hono server context — services take a DB handle + config, identity is plain email/id strings; sessions/SSO/license-key auth stay in community):

- `src/types.ts` ← `src/governance/types.ts` (StewardRole, StewardshipScope, Steward, ResolvedSteward, ReviewRequest, AccessConfig, ActivityEntry)
- `src/roles.ts` ← `src/governance/roles.ts` (EffectiveRole algebra, collabPermToRole, canViewWith/canEditWith/canApproveWith)
- `src/adapters.ts` ← `src/governance/adapters.ts` (StewardshipAdapter, ReviewAdapter, VersionAdapter, AccessAdapter, PermissionChecker)
- `src/access.ts` ← `src/shared/access.ts` (resolveNestPermission, permissionLevel, isPublicReader)
- `src/stewardship-service.ts` ← `src/governance/stewardship-service.ts` (resolveUserRoles, canUserEdit, canUserApprove, canUserAccess, canCreateInNest, canManageStewards)
- `src/access-guard.ts` ← `src/governance/access-guard.ts` (canReadNode, filterAccessible)
- `src/access-service.ts` ← `src/governance/access-service.ts` (access.yaml: isEmailAllowed, getDefaultPermission, isSuperAdmin)
- `src/trace-log.ts` ← `src/telemetry/trace-log.ts` (TraceEvent → `api_events`, 14-day retention; the `/admin/trace` HTTP route stays in community)
- `src/db/` ← governance-relevant subset of `src/db/migrations.ts`: `stewards`, `nest_collaborators`, `review_requests`, `node_versions`, `approved_versions`, `api_events` tables, with its own schema-bootstrap entry point (no dependency on community's server tables like users/sessions — user identity is caller-supplied)

**New in the package** — the engine bridge, `src/engine-governance.ts`:

- `createGovernance(ctx: {vaultPath}) => GovernanceBundle` (default export → loadable via `CONTEXTNEST_GOVERNANCE_MODULE`), configured from env/config: DB path, nest id, actor conventions.
- Hook mappings (shapes verified against both repos): `canRead` ↔ `canReadNode`; `canCommit("create")` ↔ `canCreateInNest`; `canCommit("publish")` ↔ `canUserApprove`; `update/delete/stage_suggestion` ↔ `canUserEdit`; `canIngest` ↔ `resolveNestPermission ≥ read`; `isDocOwner` ↔ `canUserEdit`; `recorder.record` ↔ `logTraceEvent` (api_events).

**Build/publish**: tsup ESM like siblings; `pnpm lint`/`test` cover it via workspace globs. **Never published to npm**: `"private": true` and added to the `ignore` list in `.changeset/config.json` — only the AGPL packages (engine, cli, mcp-server) continue releasing as today. Verify `pnpm version-packages` / `pnpm release` skip it.

**Community-repo consumption path** (documented for the follow-up, not implemented here): since the package isn't on npm, the private contextnest-community repo consumes it via a git dependency — `pnpm add "github:PromptOwl/ContextNest#path:packages/governance"` (public repo, so no auth needed; add a `prepare` script so it builds on install) — or, fallback, a vendor+sync script mirroring this repo's `plugins:sync`/`plugins:check` pattern.

## Part C — CLI & MCP wiring

- **CLI** (`packages/cli/`): global `--actor` (default `CONTEXTNEST_ACTOR` env ?? `"cli-user"`); new `src/governance.ts` with `resolveGovernance(vaultPath)` → loaded bundle or `allowAllGovernance`+noop (replaces `permissiveRbac` stub at `index.ts:237-241`). Thread `{governance, actor, origin:{client:"cli", tool:<cmd>}, recorder}` through read/query/publish/write/delete/drift commands. `UnauthorizedActionError` → clean message, non-zero exit.
- **MCP server** (`packages/mcp-server/`): actor precedence per-tool `actor` param → `CONTEXTNEST_ACTOR` → `"local-mcp"` (attribution, not authentication — authz is the hooks' job). Startup `loadGovernanceBundle`; gate read tools (`requireRead`/`filterReadable`/query options) and mutation tools; suggestion tools get loaded hooks instead of `permissiveRbac` (lines 65-69, 1013, 1063). Metadata tools stay ungated. `UnauthorizedActionError` → MCP tool error (`isError: true`).
- Docs: `packages/engine/README` section on writing/loading a governance module; `packages/governance/README` on wiring it into CLI/MCP via `CONTEXTNEST_GOVERNANCE_MODULE=@promptowl/contextnest-governance`.

## Out of scope (follow-up in contextnest-community)

Refactor the community server to depend on the governance package (git dependency) instead of its local `src/governance/*`, replace its `communityRbac` stub with the bundle, delete duplicated code. Until then the code exists in both places — acceptable transitional duplication.

## Verification

- **Engine unit tests** (reuse `makeHook` pattern from `rbac.test.ts`): `governance.test.ts` (require/filter helpers; absent=allow; deny throws with actor/action; async hooks), `storage-governance.test.ts` (no-options = identical behavior), `graph-query-governance.test.ts` (denied node excluded but still bridges A→C), `publish-governance.test.ts` (deny → no version/checkpoint/file change), **`versioning-provenance.test.ts` (critical: chains with and without `origin` both pass `verifyDocumentChain`)**, chain-log recorder mirror + throwing recorder, `governance-loader.test.ts` (precedence; malformed → ConfigError). Extend `approval.test.ts` (existing fixtures compile unchanged = compat proof).
- **Governance package tests** (`packages/governance/src/__tests__/`): port the pure-logic tests from community (`roles`, `access-service`, stewardship resolution, access-guard) against a temp SQLite DB; new tests for the `createGovernance` bridge (deny/allow flows through engine `requireRead`/`requireCommit`); trace-log write + retention.
- **`pnpm test:regression` passes with zero changes to existing cases** (backward-compat acceptance gate). Add: CLI/MCP spawned with `CONTEXTNEST_GOVERNANCE_MODULE` → deny-all fixture module → `ctx read`/`ctx publish` exit non-zero; `read_document` returns tool error. Then a second regression case pointing at the real governance build with a seeded SQLite DB (one editor, one viewer) proving the viewer can read but not publish.
- `pnpm lint`, `pnpm build`; manual `ctx query`/`ctx publish` against the dogfood vault with and without the env set.

## Compatibility / semver

- Existing vaults & hash chains untouched; mixed histories (± `origin`) verify fine; an old engine rewriting `history.yaml` drops `origin` (provenance loss only — note in changeset).
- All new params/fields optional; `RbacHook`/`denyAllRbac` unchanged. Changesets: engine/cli/mcp-server **minor**; governance **unpublished** (no changeset entries).
- Known limitation to document: `context.yaml`/`INDEX.md` remain whole-vault (denied docs' metadata visible on disk); per-actor filtering happens at read/query surfaces.

## Ordered tasks

1. Engine: `types.ts` + `schemas.ts` (new types, `origin` fields)
2. Engine: `rbac.ts` helpers + `provenance.ts`
3. Engine: `versioning.ts`, `publish.ts`, `storage.ts` gates
4. Engine: `graph-query-engine.ts` + `tracing.ts`
5. Engine: `chain-log.ts`, `approval.ts`, `suggestions.ts`, `hygienist.ts`
6. Engine: `governance-loader.ts` + barrel exports
7. Engine unit tests (chain-verification-with-origin first)
8. Licensing: `packages/governance/LICENSE.md`, root NOTICE, README split section
9. Port: governance package scaffolding (package.json/tsup/vitest, `private: true`, changeset ignore) + db schema bootstrap + types/roles/adapters/access
10. Port: stewardship-service, access-guard, access-service, trace-log
11. Governance: `engine-governance.ts` bridge + `createGovernance` factory + package tests
12. CLI wiring (`packages/cli/src/governance.ts`, global `--actor`, command threading)
13. MCP server wiring (all 19 tools, actor precedence, error mapping)
14. Regression additions, changesets, READMEs
