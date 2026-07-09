# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Context Nest is a structured second brain for AI agents — a governed, versioned knowledge base that agents can query. It provides typed graph structure, ~100x cheaper queries (~500 tokens vs 50k), and hash-chained audit trails.

## Build and Development Commands

```bash
# Install dependencies (uses pnpm workspaces; Node >=20, pnpm >=9)
pnpm install

# Build all packages
pnpm build

# Run all unit tests (excludes *.regression.test.ts)
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run a single test file
pnpm test packages/engine/src/__tests__/engine.test.ts

# Run tests matching pattern
pnpm test -- --grep "hash chain"

# Run e2e/regression suites (builds CLI + MCP server first, then spawns dist binaries)
pnpm test:regression

# Type-check without emitting (this is what "lint" means here — no eslint)
pnpm lint

# Coverage
pnpm coverage

# Re-vendor plugin shared core after editing plugins/shared/
pnpm plugins:sync

# CI guard — fails if vendored plugin copies drift from plugins/shared/
pnpm plugins:check
```

Releases use changesets: `pnpm version-packages` then `pnpm release`.

## Architecture

This is a **pnpm monorepo** with three npm packages plus agent plugins:

```
packages/
├── engine/      # Core library — parsing, storage, versioning, integrity, selectors, governance
├── cli/         # Command-line tool (`ctx` / `contextnest` binaries)
└── mcp-server/  # MCP server (`contextnest-mcp` binary) exposing vault operations as tools
plugins/
├── shared/      # Single source of truth: ctx-driving hook scripts + canonical prompts
├── claude-code/ # Claude Code plugin (built) — vault-aware hooks + agents + skill
├── codex/       # Planned (README only)
└── gemini/      # Planned (README only)
```

- `cli` and `mcp-server` both depend on `engine`; `engine` is standalone.
- `fixtures/minimal-vault/` is a committed test vault that backs the engine test suite (the rest of `fixtures/` is gitignored).
- The repo root may contain a local, untracked dogfood vault (`nodes/`, `sources/`, `packs/`).

### Engine Package (`@promptowl/contextnest-engine`)

Core modules, grouped by concern:

- **Storage & format**: `storage.ts` (vault file ops, document CRUD), `parser.ts` (markdown + YAML frontmatter), `schemas.ts` (Zod frontmatter validation), `inline.ts` (extracts `contextnest://` links, `#tags`, `@mentions` from bodies)
- **Versioning & integrity**: `versioning.ts` (keyframe + diff history), `checkpoint.ts` (nest-level atomic snapshots), `integrity.ts` (SHA-256 hash chain verification), `publish.ts` (orchestrates versioning + integrity + checkpoints + index regen)
- **Query**: `selector/` (query grammar lexer/parser/evaluators), `graph-query-engine.ts` (evaluates selectors against the `context.yaml` index without loading bodies, then traverses N hops and loads only reached nodes; falls back to full-load when the index is missing or `--full`), `graph-traverser.ts`, `resolver.ts` + `uri.ts` (`contextnest://` scheme), `packs.ts`, `injection.ts` (selector resolution + topological ordering of source nodes)
- **Governance**: `approval.ts` (approve/reject/rollback/direct-edit — the *only* paths that mutate the hash chain or live documents), `suggestions.ts`, `chain-log.ts` (persistent audit event log in `.versions/chain_events.yaml`), `rbac.ts` (identity-agnostic; the caller supplies an `RbacHook`), `classification.ts` (zone classification cascade), `hygienist.ts` (background scanner detecting out-of-band edits, routing them to the suggestion pipeline)
- **Indexing & discovery**: `index-generator.ts` (`context.yaml`), `index-md-generator.ts`, `agent-configs.ts` (generates CLAUDE.md/GEMINI.md/.cursorrules vault sections between BEGIN/END markers — only the delimited section is rewritten on `ctx index`), `registry.ts` (central vault registry at `~/.contextnest/config.yaml` mapping aliases → vault paths, so any vault can be targeted from any cwd)

### CLI Package (`@promptowl/contextnest-cli`)

Two binaries (`ctx`, `contextnest`), implemented mostly in one large `src/index.ts` (~2200 lines). Commands: `init` (with role-based starters from `src/starters/`), `add`, `update`, `delete`, `read`, `query`, `search`, `resolve`, `publish`, `verify`, `history`, `checkpoint`, `index`, `pack`, `drift` (stage/list/approve/reject suggestions), `vault` (registry management), `welcome`. Also contains `agent-tools.ts`, HTML rendering (`render-html.ts`), and anonymous telemetry (`src/telemetry/`).

### MCP Server Package (`@promptowl/contextnest-mcp-server`)

Exposes 19 tools over stdio transport:
- Read tools: `vault_info`, `resolve`, `read_document`, `read_index`, `read_pack`, `read_version`, `list_documents`, `list_checkpoints`, `search`, `document_format`, `verify_integrity`
- Mutation tools: `create_document`, `update_document`, `delete_document`, `publish_document`
- Governance tools: `stage_drift_suggestion`, `list_suggestions`, `approve_suggestion`, `reject_suggestion`

Vault targeting logic lives in `vault-resolution.ts`.

### Plugins

`plugins/shared/core/*.js` is agent-agnostic (stdin/env in, hook-output JSON out, shells to `ctx`). Each agent plugin vendors a committed copy of that core because installed Claude plugins can't read outside their own directory. **Edit `plugins/shared/`, never the vendored `plugins/<agent>/core/` copies**, then run `pnpm plugins:sync`. CI enforces this with `pnpm plugins:check`.

## Key Concepts

**Node Types**: `document`, `snippet`, `glossary`, `persona`, `prompt`, `source`, `tool`, `reference`, `skill`

**Selector Grammar**: Composable query language for selecting documents
- Tags: `#engineering`
- Types: `type:document`
- Packs: `pack:onboarding.basics`
- Operators: `+` (AND), `|` (OR), `-` (NOT)

**URI Scheme**: `contextnest://path`, `contextnest://path@N` (pinned to checkpoint N), `contextnest://path#section`

**Version Model**: Keyframe + diff storage (keyframes every 10 versions by default)

**Integrity**: SHA-256 hash chains for both document versions and nest checkpoints, plus a governance event log (`chain_events.yaml`)

## Testing

Tests use **Vitest** with workspace configuration. Each package has its own `__tests__/` directory.

- `pnpm test` runs unit tests only — `*.regression.test.ts` files are excluded.
- `pnpm test:regression` uses `vitest.regression.config.ts`: it builds the CLI and MCP server first, then runs subprocess-heavy e2e suites (spawned `dist/` binaries, 60s timeouts, forked pool). If you change CLI or MCP server behavior, run this too.
- Plugin tests live in `plugins/__tests__/` with their own `plugins/vitest.config.ts`.

## TypeScript Configuration

- Target: ES2022, Module: ESNext with bundler resolution, strict mode
- Build tool: tsup (ESM output)

## Specification

The full technical specification is in `CONTEXT_NEST_SPEC.md`. Key sections:
- §1: Document format and frontmatter
- §2: Selector grammar
- §3: Context packs
- §4: URI scheme (`contextnest://`)
- §5: `context.yaml` index generation
- §6-8: Version history and integrity verification
- §9: Context injection and audit tracing
