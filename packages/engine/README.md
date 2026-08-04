# @promptowl/contextnest-engine

The governed, versioned context engine for AI agents — **not a memory store.**

[![npm](https://img.shields.io/npm/v/@promptowl/contextnest-engine.svg)](https://www.npmjs.com/package/@promptowl/contextnest-engine)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![SOC 2 Type 2](https://img.shields.io/badge/SOC%202-Type%202-green.svg)](https://promptowl.ai)

The core engine behind [Context Nest](https://github.com/PromptOwl/ContextNest). It turns a folder of markdown into a typed, queryable document graph where every change is hash-chained and auditable. Where a memory store appends opaque blobs and hopes for recall, this engine gives agents a deterministic query grammar, graph traversal, and a byte-level audit trail — the same vault onboards one developer in ten minutes and passes a SOC 2 review when that day comes.

## Install

```bash
npm install @promptowl/contextnest-engine
```

## Quickstart

```typescript
import { NestStorage, GraphQueryEngine } from "@promptowl/contextnest-engine";

const storage = new NestStorage("/path/to/vault");
const engine = new GraphQueryEngine(storage);

// Deterministic selector + graph traversal (default: 2 hops).
// Selectors match document metadata first — no file bodies loaded —
// then BFS over relationship edges, loading bodies only for reached nodes.
const result = await engine.query("#engineering + type:document", { hops: 3 });

for (const doc of result.documents) {
  console.log(`${doc.id}: ${doc.frontmatter.title}`);
}
```

## Worked Example

Read a vault, query its engineering skills, then verify the whole vault's integrity.

```typescript
import {
  NestStorage,
  GraphQueryEngine,
  CheckpointManager,
} from "@promptowl/contextnest-engine";

const storage = new NestStorage("./my-vault");
const engine = new GraphQueryEngine(storage);

// 1. Pull every skill node tagged #engineering, 2 hops of related context.
const skills = await engine.query("type:skill + #engineering", { hops: 2 });
console.log(`Found ${skills.documents.length} engineering skills`);

for (const skill of skills.documents) {
  const { title } = skill.frontmatter;
  const trigger = skill.frontmatter.skill?.trigger ?? "(no trigger)";
  console.log(`- ${title} — triggers ${trigger}`);
}

// 2. Verify the hash chain across the entire vault before trusting it.
const checkpoints = new CheckpointManager(storage);
const report = await checkpoints.verify();
console.log(report.valid ? "Integrity OK" : `Tampering: ${report.errors}`);
```

## What It Does

- **Selector Grammar** — Deterministic query language: select by tag, type, URI, pack, status, and boolean combinations (`type:skill + #engineering`)
- **Graph Traversal** — Hop-based BFS over `context.yaml` as a lightweight graph index, with priority-weighted edges
- **Skill Nodes** — First-class `type: skill` nodes with trigger, inputs, tools_required, output_format, and guard_rails
- **Versioning** — Hash-chained version history with keyframe + diff reconstruction; each non-keyframe version's change log is a standalone `v{N}.diff` unified diff beside the keyframes
- **Operation Catalog** — `@promptowl/contextnest-engine/api`: one canonical, schema-described set of operations (`context_get`, `context_query`, `context_create`, …) that CLI, MCP, and REST surfaces bind to instead of hand-rolling their own
- **Integrity** — SHA-256 content hashes, chain hashes, and checkpoint verification down to the byte
- **URI Resolution** — Resolve `contextnest://` URIs to documents, tags, folders, or search results
- **Storage** — Read/write documents, version histories, checkpoints, and config from the vault file system
- **Parsing & Validation** — Markdown + YAML frontmatter, validated against the spec (skill and source node rules)
- **Index Generation** — Generate `context.yaml` (document graph) and `INDEX.md`
- **Agent Config Generation** — Auto-generate CLAUDE.md, GEMINI.md, .cursorrules, etc. so AI tools discover the vault

## Graph Traversal

The engine evaluates selectors against document metadata (no bodies loaded), then traverses relationship edges via BFS for N hops, loading bodies only for reached nodes.

- `depends_on` edges and edges to hub nodes are free (always traversed)
- `reference` edges cost 1 hop
- Edges with explicit `priority: 0` in frontmatter are free
- Adaptive expansion retries with more hops if too few results

## Key Exports

| Export | Description |
|--------|-------------|
| `NestStorage` | File system abstraction for vault operations |
| `GraphQueryEngine` | Graph-aware query orchestrator (recommended) |
| `GraphTraverser` | BFS traversal with priority-weighted edge costs |
| `Resolver` | URI resolution against an in-memory document set |
| `ContextInjector` | Legacy full-load query orchestrator |
| `VersionManager` | Document version history management |
| `CheckpointManager` | Vault-wide checkpoint management |
| `generateContextYaml` | Generate the `context.yaml` graph index |
| `generateAgentConfigs` | Generate AI tool config files |
| `parseSelector` | Parse selector query strings into AST |
| `evaluateFromIndex` | Evaluate selectors against the lightweight index (no bodies) |
| `publishDocument` | Publish a document (bump version, checkpoint) |
| `publishDocuments` | Bulk publish — one checkpoint and one index pass for the whole batch |
| `parseStewards` / `serializeStewards` | Canonical `stewards.yaml` marshalling (format only) |
| `traverseWikiGraph` | `[[wikilink]]` seed resolution and hop traversal |

Errors all carry a `code`: `InvalidSelectorError`, `CorruptHistoryError`,
`VersionArtifactExistsError`, and the rest are exported from the package root.

## Operation Catalog

`@promptowl/contextnest-engine/api` is a second entry point holding the canonical
operation set — the same names, input/output schemas, and error codes that the
CLI, the MCP server, and REST surfaces bind to, so an agent config written
against one works unchanged against another.

```typescript
import {
  NestStorage,
  GraphQueryEngine,
  VersionManager,
} from "@promptowl/contextnest-engine";
import { createEngineApi } from "@promptowl/contextnest-engine/api";

const storage = new NestStorage("./my-vault");
const ctx = {
  storage,
  query: new GraphQueryEngine(storage),
  versions: new VersionManager(storage),
};

const api = createEngineApi();
const doc = await api.run("context_get", { id: "nodes/api-design" }, ctx);
```

`run(name, input, ctx)` resolves the operation (canonical name or legacy alias),
validates the input, runs every extension's authorize gate, executes, and
notifies `onResult`. The context is identity-agnostic and per-vault — the same
primitives every surface already builds.

Each operation exposes a Zod schema plus a draft-07 `inputJsonSchema` /
`outputJsonSchema` for tool manifests. `EngineExtension` lets a consumer register
extra operations and wrap every call with `authorize` / `onResult` without
forking the engine — governance policy stays out of the AGPL core.

## Part of Context Nest

The engine is the library layer. Most users reach it through one of these:

| Surface | What it is |
|---|---|
| [@promptowl/contextnest-cli](https://www.npmjs.com/package/@promptowl/contextnest-cli) | The `ctx` command — `ctx init`, `ctx query`, `ctx verify` |
| [@promptowl/contextnest-mcp-server](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server) | MCP server exposing 19 vault tools to Claude, Cursor, Gemini, and Copilot |
| [Claude integration](https://github.com/PromptOwl/ContextNest#mcp-server) | Drop-in MCP config for Claude Code and Claude Desktop |

## Links

- [Context Nest repo](https://github.com/PromptOwl/ContextNest)
- [Specification](https://github.com/PromptOwl/context-nest-spec)
- [Whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/)
- [PromptOwl](https://promptowl.ai)
- [Discord](https://discord.gg/fxcSQ5gq)

## License

AGPL-3.0. Commercial licensing available from [PromptOwl](https://promptowl.ai) for embedding without AGPL obligations.
