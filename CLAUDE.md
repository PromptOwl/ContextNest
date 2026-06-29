# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Context Nest is a structured second brain for AI agents — a governed, versioned knowledge base that agents can query. It provides typed graph structure, ~100x cheaper queries (~500 tokens vs 50k), and hash-chained audit trails.

## Build and Development Commands

```bash
# Install dependencies (uses pnpm workspaces)
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type-check without emitting
pnpm lint

# Clean all build artifacts
pnpm clean

# Run a single test file
pnpm test packages/engine/src/__tests__/engine.test.ts

# Run tests for a specific package
pnpm --filter @promptowl/contextnest-engine test
```

## Architecture

This is a **pnpm monorepo** with three packages:

```
packages/
├── engine/      # Core library — parsing, storage, versioning, integrity, selectors
├── cli/         # Command-line tool (`ctx` / `contextnest`)
└── mcp-server/  # MCP server exposing vault operations as tools for AI agents
```

### Package Dependencies

- `cli` → depends on `engine`
- `mcp-server` → depends on `engine`
- `engine` → standalone core library

### Engine Package (`@promptowl/contextnest-engine`)

The core library implementing the Context Nest specification:

| Module | Purpose |
|--------|---------|
| `storage.ts` | Vault file operations, document CRUD |
| `parser.ts` | Markdown + YAML frontmatter parsing |
| `versioning.ts` | Keyframe + diff version history |
| `checkpoint.ts` | Nest-level atomic snapshots |
| `integrity.ts` | SHA-256 hash chain verification |
| `selector/` | Query grammar parser and evaluator |
| `graph-traverser.ts` | Relationship graph traversal |
| `resolver.ts` | URI resolution (`contextnest://` scheme) |
| `schemas.ts` | Zod schemas for frontmatter validation |

### CLI Package (`@promptowl/contextnest-cli`)

Provides two binary commands: `ctx` and `contextnest`

Key commands: `init`, `add`, `update`, `delete`, `read`, `query`, `publish`, `verify`, `history`

### MCP Server Package (`@promptowl/contextnest-mcp-server`)

Exposes 19 tools over stdio transport for AI agents:
- Read tools: `vault_info`, `resolve`, `read_document`, `list_documents`, `search`, `verify_integrity`
- Mutation tools: `create_document`, `update_document`, `delete_document`, `publish_document`
- Governance tools: `stage_drift_suggestion`, `list_suggestions`, `approve_suggestion`, `reject_suggestion`

## Key Concepts

**Node Types**: `document`, `snippet`, `glossary`, `persona`, `prompt`, `source`, `tool`, `reference`, `skill`

**Selector Grammar**: Composable query language for selecting documents
- Tags: `#engineering`
- Types: `type:document`
- Packs: `pack:onboarding.basics`
- Operators: `+` (AND), `|` (OR), `-` (NOT)

**URI Scheme**: `contextnest://path`, `contextnest://path@N` (pinned to checkpoint N), `contextnest://path#section`

**Version Model**: Keyframe + diff storage (keyframes every 10 versions by default)

**Integrity**: SHA-256 hash chains for both document versions and nest checkpoints

## Testing

Tests use **Vitest** with workspace configuration. Each package has its own `__tests__/` directory.

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test packages/engine/src/__tests__/engine.test.ts

# Run tests matching pattern
pnpm test -- --grep "hash chain"
```

## TypeScript Configuration

- Target: ES2022
- Module: ESNext with bundler resolution
- Strict mode enabled
- Build tool: tsup

## Specification

The full technical specification is in `CONTEXT_NEST_SPEC.md`. Key sections:
- §1: Document format and frontmatter
- §2: Selector grammar
- §4: URI scheme (`contextnest://`)
- §6-8: Version history and integrity verification
