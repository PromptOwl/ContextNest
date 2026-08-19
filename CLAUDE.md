# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Context Nest is a structured second brain for AI agents — a governed, versioned knowledge base that agents can query. It provides typed graph structure, ~100x cheaper queries (~500 tokens vs 50k), and hash-chained audit trails.

Requires Node >= 20 and pnpm >= 9. CI runs the full matrix on ubuntu/windows/macOS × Node 20/22, so **cross-platform correctness matters** — normalize CRLF, avoid POSIX-only path assumptions, and don't shell out to tools Windows lacks (`jq`, etc.).

## Build and Development Commands

```bash
pnpm install
pnpm build              # tsup, all packages
pnpm lint               # tsc --noEmit, all packages
pnpm test               # vitest — unit + structural (regression suites EXCLUDED)
pnpm test:regression    # builds CLI + MCP server first, then runs *.regression.test.ts
pnpm clean

# Single file / pattern / package
pnpm test packages/engine/src/__tests__/engine.test.ts
pnpm test -t "hash chain"
pnpm --filter @promptowl/contextnest-engine test

# Plugin vendoring (see "Plugins" below) — run after editing plugins/shared/
pnpm plugins:sync
pnpm plugins:check      # CI guard; fails on drift
```

`pnpm test` and `pnpm test:regression` are separate on purpose: regression suites spawn the *built* `dist/index.js` of the CLI and MCP server against throwaway vaults, so they need a build first and are slow. Editing engine/CLI source and running only `pnpm test` will not exercise them.

## Architecture

pnpm monorepo, two workspaces of interest:

```
packages/       # published npm packages (engine ← cli, mcp-server)
plugins/        # coding-agent plugins that drive the ctx CLI (not published to npm)
```

`packages/governance/` is untracked local build residue — ignore it.

### Engine (`@promptowl/contextnest-engine`)

Standalone core implementing `CONTEXT_NEST_SPEC.md`. Notable modules beyond the obvious CRUD:

| Module | Purpose |
|--------|---------|
| `parser.ts` / `schemas.ts` | Markdown + YAML frontmatter; Zod validation rules 1–17 (spec §13) |
| `storage.ts` | Vault file operations, document CRUD |
| `versioning.ts` / `checkpoint.ts` | Keyframe+diff history; nest-level atomic snapshots |
| `integrity.ts` / `chain-log.ts` | SHA-256 hash chains and their audit log |
| `selector/` | `lexer` → `parser` → `evaluator` (+ `index-evaluator` for the fast path over `context.yaml`) |
| `graph-traverser.ts` / `graph-query-engine.ts` / `wiki-graph.ts` | Relationship traversal and `[[wikilink]]` graph |
| `registry.ts` | Central vault registry at `~/.contextnest/config.yaml` — see resolution order below |
| `source-graph.ts` | Live `source` nodes (MCP/REST/CLI/function transports) |
| `packs.ts` | Saved selector bundles (`pack:name`) |
| `suggestions.ts` / `approval.ts` / `rbac.ts` / `stewards.ts` | Drift suggestions, approval workflow, role scoping |
| `hygienist.ts` / `index-generator.ts` / `index-md-generator.ts` | Vault health checks; `context.yaml` and `INDEX.md` regeneration |
| `agent-configs.ts` | Generates CLAUDE.md / agent config blocks into a target project |

**Vault resolution** (`resolveVaultPath()`, highest precedence first) — a frequent source of "wrong vault" bugs:
`--vault <alias>` → `CONTEXTNEST_VAULT` (alias) → `CONTEXTNEST_VAULT_PATH` (abs path) → positional arg → local `.context/config.yaml` found by walking up cwd → registry `default:` → cwd.

### CLI (`@promptowl/contextnest-cli`)

Binaries `ctx` and `contextnest`, both from a single ~2k-line `src/index.ts` (commander). Command groups: document CRUD (`add`/`update`/`delete`/`read`/`publish`), query (`query`/`search`/`resolve`/`list`), integrity (`verify`/`history`/`reconstruct`/`checkpoint`), governance (`drift stage|list|approve|reject`), and multi-vault (`vault add|list|remove|default|which`). `init` scaffolds from `src/starters/` — the starter prompt bodies are the agent-facing onboarding text and have their own tests.

### MCP Server (`@promptowl/contextnest-mcp-server`)

35 tools over stdio, in three groups:

- **Catalog-driven** (16, registered by looping over `listOperations("core")` — name, description and schema all come from the engine's operation catalog, so this surface cannot drift, and a new core op appears here automatically): `context_init`, `context_nests`, `context_get`, `context_list`, `context_search`, `context_query`, `context_resolve`, `context_versions`, `context_reconstruct`, `context_packs`, `context_verify`, `context_create`, `context_update`, `context_publish`, `context_delete`, `context_import`. **Add new tools here, not by hand.**
- **Hand-written, still current** (8): `document_format`, `read_index`, `read_pack`, `list_checkpoints`, `stage_drift_suggestion`, `list_suggestions`, `approve_suggestion`, `reject_suggestion`.
- **Deprecated** (11, kept byte-identical for existing clients, removed in a future major): `vault_info`, `resolve`, `read_document`, `list_documents`, `search`, `verify_integrity`, `read_version`, `create_document`, `update_document`, `delete_document`, `publish_document`.

### Plugins (`plugins/`)

Makes coding agents vault-aware (auto-retrieve) and self-maintaining (deliberate capture + consistent corrections) by shelling out to `ctx`. Only the Claude Code plugin is built; Codex/Gemini are README-only.

**`plugins/shared/` is the single source of truth. Never edit `plugins/claude-code/core/` — it is a vendored byte-identical copy.** Installed Claude plugins can't read files outside their own directory, so `pnpm plugins:sync` copies `shared/core/*` into each agent plugin and fills the `<!-- BEGIN SHARED -->…<!-- END SHARED -->` regions of agent/skill markdown from `shared/prompts/*.md`. `pnpm plugins:check` fails CI on drift.

Each `core/*.js` module exports a **pure** `run({ input, env, exec })` returning the hook-output object (or `null` to do nothing), plus a thin IO shell guarded by `isMain(import.meta.url)`. Tests call `run()` with a fake `exec` — no subprocess. Zero runtime deps, plain Node ESM.

Config comes from env, `CLAUDE_PLUGIN_OPTION_*` with `CONTEXTNEST_*` fallbacks (so non-Claude agents can feed the same values): `RETRIEVAL_MODE` (`off`/`search`/`query`/`agent`, default `search`), `CAPTURE_MODE` (`off`/`propose`/`auto`, default `propose`), `VAULT` (pinned alias), `CTX_COMMAND` (default `ctx`). `AUTO_CAPTURE` is deprecated but still read (`true`→`propose`, `false`→`off`); an explicit `CAPTURE_MODE` wins at any layer.

**Writes are gated in code, not in prose.** `capture-gate.js` decides *whether* to engage the vault (explicit intent → correction → substantive-and-out-of-cooldown, tracked per session in `~/.contextnest/plugin-state/`); the prompts decide *what*. When changing capture behaviour, change the gate — a prompt cannot be unit-tested and the old "under-capture is the failure mode" framing is exactly what made the plugin noisy.

Hooks: `SessionStart` → vault overview injection, `UserPromptSubmit` → retrieval **and dispatch of any parked job**, `Stop` → capture gate.

**The Stop hook never blocks.** It used to return `decision: "block"`, which held the turn open while a subagent ran. It now parks `{kind, reason, turn}` in the session ledger and returns only a `systemMessage`; the next `UserPromptSubmit` drains the queue and hands the directive over as `additionalContext` (the field the model acts on — Stop's own `additionalContext` is transcript metadata it does not act on). `contextnest-capture` and `contextnest-curator` are `background: true` so the dispatched work overlaps the user's next request. Note `saveLedger` writes an explicit key projection: a new ledger field must be added to the `EMPTY` sentinel, the `loadLedger` projection **and** the `saveLedger` stringify, or it is dropped silently.

## Key Concepts

**Node types**: `document`, `snippet`, `glossary`, `persona`, `prompt`, `source`, `tool`, `reference`, `skill`

**Statuses**: `draft`, `pending_review`, `approved`, `published`, `rejected`. Parse-time aliasing normalizes legacy/foreign values (case-insensitive; unknown → `draft`); disk always stores canonical values, re-canonicalized on round-trip through `serializeDocument` or `ctx index`.

**Selector grammar**: `#tag`, `type:document`, `pack:onboarding.basics`, with `+` (AND), `|` (OR), `-` (NOT).

**URI scheme**: `contextnest://path`, `@N` (pinned to checkpoint N), `#section`.

**Version model**: keyframe + diff (keyframe every 10 versions by default), SHA-256 hash-chained for both document versions and nest checkpoints.

## Releasing

Changesets. `pnpm version-packages` (`changeset version` + lockfile refresh), then `pnpm release`. All three packages are AGPL-3.0 and versioned together.

## Specification

`CONTEXT_NEST_SPEC.md` is normative — §1 document format, §2 selectors, §3 packs, §4 URI scheme, §5 `context.yaml`, §6–8 versions/checkpoints/integrity, §9 injection & tracing, §10 INDEX.md, §13 validation rules.
