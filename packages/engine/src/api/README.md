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
| **Catalog (schemas)** | `core` namespace — 7 ops. Zod input/output + draft-07 JSON Schema per op. Canonical names are `context_*`; OSS legacy names are captured as `aliases`. Schemas compose the engine's existing domain schemas (`frontmatterSchema`, `NODE_TYPES`, …) — no duplication. |
| **Executable ops** | `createEngineApi().run(name, input, ctx)` — one implementation bound to engine primitives (`GraphQueryEngine`, `NestStorage`, `publishDocument`). Ungated mechanics only; no governance policy in the engine (preserves the AGPL↔Commercial line). |
| **Extension framework** | `EngineExtension` lets consumers register new ops (governance/workflow/sync) and wrap every op with `authorize` + `onResult`, without forking the engine. |
| **Namespace discovery** | `NAMESPACES` advertises the implemented set for MCP `initialize` / REST manifest. |

### `core` operations

`context_get` · `context_query` · `context_resolve` · `context_list` ·
`context_search` · `context_create` · `context_update`

`governance`, `workflow`, and `sync` namespaces are **declared but not yet
populated** (`implemented: false`) — those come in later phases.

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
