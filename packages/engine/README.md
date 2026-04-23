# @promptowl/contextnest-engine

Core engine for [Context Nest](https://github.com/PromptOwl/ContextNest) — structured, versioned context vaults for AI agents.

## Install

```bash
npm install @promptowl/contextnest-engine
```

## What It Does

The engine provides the core building blocks for Context Nest vaults:

- **Storage** — Read/write documents, version histories, checkpoints, and config from the vault file system
- **Parsing & Validation** — Parse markdown documents with YAML frontmatter, validate against the spec (including skill and source node rules)
- **Selector Grammar** — Deterministic query language for selecting documents by tag, type, URI, pack, and boolean combinations
- **Skill Nodes** — First-class support for `type: skill` nodes with trigger, inputs, tools_required, output_format, and guard_rails
- **Graph Traversal** — Hop-based BFS traversal using `context.yaml` as a lightweight graph index, with priority-weighted edges
- **URI Resolution** — Resolve `contextnest://` URIs to documents, tags, folders, or search results
- **Versioning** — Hash-chained version history with keyframe + diff reconstruction
- **Integrity** — SHA-256 content hashes, chain hashes, and checkpoint verification
- **Index Generation** — Generate `context.yaml` (document graph) and `INDEX.md` files
- **Agent Config Generation** — Auto-generate CLAUDE.md, GEMINI.md, .cursorrules, etc. so AI tools discover the vault

## Quick Example

```typescript
import { NestStorage, GraphQueryEngine } from "@promptowl/contextnest-engine";

const storage = new NestStorage("/path/to/vault");
const engine = new GraphQueryEngine(storage);

// Query with graph traversal (default: 2 hops)
const result = await engine.query('#engineering + type:document', { hops: 3 });

// Query skill nodes
const skills = await engine.query('type:skill + #engineering', { hops: 2 });

for (const doc of result.documents) {
  console.log(`${doc.id}: ${doc.frontmatter.title}`);
}
```

## Key Exports

| Export | Description |
|--------|-------------|
| `NestStorage` | File system abstraction for vault operations |
| `GraphQueryEngine` | Graph-aware query orchestrator (recommended) |
| `GraphTraverser` | BFS traversal with priority-weighted edge costs |
| `Resolver` | URI resolution against in-memory document set |
| `ContextInjector` | Legacy full-load query orchestrator |
| `VersionManager` | Document version history management |
| `CheckpointManager` | Vault-wide checkpoint management |
| `generateContextYaml` | Generate the `context.yaml` graph index |
| `generateAgentConfigs` | Generate AI tool config files |
| `parseSelector` | Parse selector query strings into AST |
| `evaluateFromIndex` | Evaluate selectors against lightweight index (no bodies) |
| `publishDocument` | Publish a document (bump version, checkpoint) |

## Graph Traversal

The engine uses `context.yaml` as a pre-built graph index. Queries evaluate selectors against document metadata (no file bodies loaded), then traverse relationship edges via BFS for N hops, and only load bodies for reached nodes.

- `depends_on` edges and edges to hub nodes are free (always traversed)
- `reference` edges cost 1 hop
- Edges with explicit `priority: 0` in frontmatter metadata are free
- Adaptive expansion retries with more hops if too few results

## Links

- [Context Nest repo](https://github.com/PromptOwl/ContextNest)
- [Specification](https://github.com/PromptOwl/context-nest-spec)
- [PromptOwl](https://promptowl.ai)
- [Discord](https://discord.gg/fxcSQ5gq)

## License

AGPL-3.0
