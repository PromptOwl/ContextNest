# `@promptowl/contextnest-engine/api`

The **canonical operation catalog** — one transport-agnostic source of truth for
every ContextNest operation. MCP tools, `ctx` CLI commands, and REST routes are
three *bindings* of this catalog; they import their schemas from here instead of
hand-writing them.

This module is **API Convergence Phase 1**. See the PRD for the full plan.

## Why this exists

The same operations had forked into three vocabularies — OSS MCP
(`read_document`, `resolve`…), Community MCP (`context_get`, `context_query`…),
and the `ctx` CLI — each hand-writing its own JSON Schemas (~1,100 lines that
diverged silently). This module makes the engine the single schema source so
divergence stops at the root.

## What Phase 1 ships

| Piece | What |
|---|---|
| **Catalog (schemas)** | `core` namespace — 17 ops. Zod input/output + draft-07 JSON Schema per op. Canonical names are `context_*`; OSS legacy names are captured as `aliases`. Schemas compose the engine's existing domain schemas (`frontmatterSchema`, `NODE_TYPES`, …) — no duplication. |
| **Executable ops** | `createEngineApi().run(name, input, ctx)` — one implementation bound to engine primitives (`GraphQueryEngine`, `NestStorage`, `publishDocument`). Ungated mechanics only; no governance policy in the engine (preserves the AGPL↔Commercial line). |
| **Extension framework** | `EngineExtension` lets consumers register new ops (governance/workflow/sync) and wrap every op with `authorize` + `onResult`, without forking the engine. |
| **Namespace discovery** | `NAMESPACES` advertises the implemented set for MCP `initialize` / REST manifest. |

### `core` operations (17)

Read: `context_get` · `context_query` · `context_resolve` · `context_list` ·
`context_search` · `context_overview` · `context_packs` · `context_init`
Write/lifecycle: `context_create` · `context_update` · `context_publish` ·
`context_delete` · `context_import` (bulk create+publish, one checkpoint)
History/audit: `context_versions` · `context_reconstruct` · `context_verify`
Registry: `context_nests` (list every registered nest)

These cover the operations all three surfaces (OSS MCP, CLI, Community MCP)
expose, so Phase 2 bindings import them instead of hand-rolling. `governance`,
`workflow`, and `sync` namespaces are **declared but not yet populated**
(`implemented: false`) — those come in later phases.

#### `context_nests` is registry-scoped, not vault-scoped

Every other `core` op runs against the one vault in its `OperationContext`.
`context_nests` reads the **central registry** (`~/.contextnest/config.yaml`,
`listVaults()`) and therefore ignores `ctx` entirely — `storage`, `query`, and
`versions` are unused. Do not wire them in; there is no single vault this
operation belongs to. Bindings should still pass a real `OperationContext` —
extension `authorize` hooks run before the executor and may dereference it.

```text
input:  {}
output: { nests: [{ alias, path, description?, isDefault, exists }] }
errors: CONFIG_ERROR | VALIDATION_FAILED
```

`description` resolves registry-entry description first, falling back to the
nest's own `.context/config.yaml` `description` (spec §11.1), then its `name`.
The registry entry is a machine-local label; the config value is the nest's own
description and travels with the vault.

Bindings exposing this over a network transport should note that `path` leaks
filesystem topology across vaults — the registry file is written `0600` for
exactly that reason. Local stdio MCP and the CLI already have filesystem
access, so both include it.

### `client` — caller metadata on every read and write

Every `core` operation takes an optional `client` object naming the calling
agent and its session, plus any custom scalar keys (spec §9.4):

```jsonc
// write
{ "title": "API Design", "content": "…",
  "client": { "agent": "claude-code", "session_id": "s-9f2", "workspace": "acme" } }

// read
{ "query": "#api", "client": { "agent": "claude-code", "session_id": "s-9f2" } }
```

| Operation kind | Where it lands |
|---|---|
| Writes that publish (`context_create`, `context_update`, `context_publish`, `context_import`) | The version-history entry the publish seals — `context_versions` returns it as `client` on each entry |
| Graph reads (`context_query`, `context_resolve`, `context_search`) | The §9.2 access traces the query emits |
| Everything else | Extension `authorize` / `onResult` hooks, which receive the validated input |

Three things it is not:

- **Not identity.** The engine never authenticates `agent` and no executor
  branches on it. Authorization stays with the `RbacHook` and the context's
  `actor`.
- **Not hashed.** `VersionEntry.client` is deliberately outside
  `computeChainHash`'s inputs, so a history recorded before the field existed
  still verifies byte-for-byte.
- **Not `metadata`.** `metadata` on create/update/import is *frontmatter* — it
  lands in the document. `client` describes the call that touched it. The two
  mean opposite things, which is why they cannot share a name.

Bounded on purpose (`clientMetadataSchema` in `schemas.ts`): values are scalars
of at most 512 chars, and at most 16 custom keys beyond the reserved two.
It is written into an append-only audit trail by a caller we do not trust.

## Public API

```ts
import {
  OPERATIONS,        // canonical name → descriptor (frozen)
  NAMESPACES,        // which namespaces this catalog implements
  getOperation,      // look up by canonical name OR legacy alias
  listOperations,    // all ops, or filtered by namespace
  inputJsonSchema,   // draft-07 JSON Schema for an op's input
  outputJsonSchema,  // draft-07 JSON Schema for an op's output
  createEngineApi,   // executable runtime: .run(name, input, ctx)
  clientField,       // { client } — spread into an extension op's input object
  clientMetadataSchema,
  type ClientMetadata,
} from "@promptowl/contextnest-engine/api";
```

## What this is NOT (yet)

- **Not wired into the MCP servers or CLI.** Those bindings migrate to import
  from here in Phase 2 — until then the old inline schemas still live in
  `packages/mcp-server` and the CLI (two sources of truth in the interim).
- **No governance enforcement.** The engine ships signatures only; eligibility
  gates, scope resolution, and approvals stay in Community.
- **`context_update` only adds tags** (merges + de-dupes); there is no tag
  removal yet — a follow-up if surfaces need it.

## Next phases (not in this PR)

- **Phase 2** — MCP servers + CLI import from here; OSS adopts `context_*` names
  with old names as deprecated aliases.
- **Phase 3** — conformance suite + lint rule (no inline `inputSchema` literals)
  fail the build on divergence.
- **Phase 4** — one `ctx` CLI with `local` and `remote` (Community REST) backends.
