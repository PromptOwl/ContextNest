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

**7 packages at depth 2**, down from 76. The markdown AST, glob and frontmatter dependencies were
removed outright rather than swapped, and no install script runs. Every package is listed with its
version and licence in
[DEPENDENCIES.md](https://github.com/PromptOwl/ContextNest/blob/main/DEPENDENCIES.md).

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
- **Operation Catalog** — `@promptowl/contextnest-engine/api`: one canonical, schema-described set of 17 operations (`context_get`, `context_query`, `context_create`, …) that CLI, MCP, and REST surfaces bind to instead of hand-rolling their own. As of 2.0 the `core` namespace is complete and every surface actually runs on it
- **Integrity** — SHA-256 content hashes, chain hashes, and checkpoint verification down to the byte
- **URI Resolution** — Resolve `contextnest://` URIs to documents, tags, folders, or search results
- **Storage** — Read/write documents, version histories, checkpoints, and config from the vault file system; discovery is folder-scoped, and `listFolders` returns the vault's shape from directory entries without parsing a document
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
| `publishDocuments` | Bulk publish — one checkpoint and one index pass for the whole batch, with an `onProgress(done, total)` sink |
| `filterDocuments` | The one type / status / tag filter, for surfaces that filter a list they already hold |
| `setVaultDescription` | Set or clear a registry alias's description |
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

`OperationContext.onProgress(done, total)` is an optional sink for long-running
operations such as `context_import`. It lives on the context rather than in an
operation's input because inputs must stay JSON-serializable for the MCP/REST
wire; in-process callers supply it, wire transports leave it undefined.

`context_nests` is the catalog's first **registry-scoped** operation — it reads
`~/.contextnest/config.yaml` rather than one vault, so it ignores its
`OperationContext`.

## Browsing Without Reading

Discovery's cost is parsing every markdown file it finds, so a caller that only
needs the vault's *shape* should not pay it. Two operations narrow the crawl
rather than the result:

- `context_folders` (and `NestStorage.listFolders`) returns each folder's path
  and its document count, read from directory entries without opening a single
  document. Folders are read rather than inferred from the documents inside
  them, so a folder holding only subfolders still appears.
- `context_list` and `NestStorage.discoverDocuments` take `folder` — a path
  relative to the vault root, i.e. the id prefix (`"nodes/gtm"`, not `"gtm"`) —
  and `recursive`. With `recursive: false` a folder's subfolders are never
  opened, so a lazily-expanded document tree pays only for the level it shows.

```typescript
const { folders } = await api.run("context_folders", { recursive: false }, ctx);
// → [{ path: "nodes", count: 0 }, …]

const { documents } = await api.run(
  "context_list",
  { folder: "nodes/gtm", recursive: false },
  ctx,
);
```

Previously the only way to browse one folder was to read and parse every
document in the vault and filter afterwards, which costs the same as not
filtering — painful on a large vault, and worse on a network-backed mount where
each document is a round trip.

## Importing an Existing Folder

`context_import` bulk-publishes in one pass — one checkpoint and one index
regeneration for the whole batch, with failures reported per-document rather
than aborting the rest. It takes four kinds of input:

| Input | What it does |
|---|---|
| `documents` | New nodes synthesized from `title` + `content` |
| `ids` | Documents already written into the vault, published as-is |
| `files` | An existing vault's files written **verbatim** at their own relative paths |
| `discover` | The engine scans the vault itself and decides what to publish |

`files` synthesizes nothing, so the source's own frontmatter survives (`version`,
`checksum`, custom keys a generated draft would drop) and non-document files
travel too — `.versions/<doc>/history.yaml` included, which is what lets an
imported version chain still reconstruct. Paths are guarded: `..` and absolute
paths are rejected per-file rather than aborting the import.

`publish: false` stages `files` without publishing them, so an upload arriving in
several batches can stage every batch and make one final `discover` call — the
import seals **one** checkpoint rather than one per batch.

```typescript
// Stage each batch as it arrives…
await api.run("context_import", { files: batch, publish: false }, ctx);

// …then let the engine take responsibility for the whole vault, once.
const result = await api.run(
  "context_import",
  { discover: true, author: "alice", exclude_ids: alreadyImported },
  ctx,
);

// result.documents: { id, title, version, status, tags, content } per document —
// enough to record the import without re-reading the vault.
// result.checkpoint: the single checkpoint sealing the batch.
```

**Publishing is opt-in.** Only a document whose frontmatter explicitly says
`published` or `approved` is published. Everything else is held as a draft —
including a document that states no status at all, because saying nothing is not
consent. A vault of hand-authored notes carries no governance state, and
importing it should not decide on the author's behalf that every note is fit to
serve to an AI. Held is recoverable; published-by-default is not, since the
exposure has already happened by the time anyone reviews it. A held document is
stamped with an explicit `status: draft` so a file read outside the engine is
never ambiguous — except where the author already wrote `pending_review` or
`rejected`, which is theirs to keep.

`exclude_ids` skips what an earlier run already took, so a re-import is
idempotent. `parser.explicitStatus(node)` exposes the same distinction the
importer relies on: the status the author actually wrote, or `null` where
`parseDocument` would have defaulted to `draft`.

## Upgrading to 2.0

Vault files are unchanged. The API breaks in five places:

- **`context_overview` is removed.** `context_init` returns everything it did
  plus the vault's `CONTEXT.md` instructions, configuration and path — one call
  to open a vault instead of two. The node list is opt-in behind `include_nodes`
  (with `limit`).
- **Ids are taken exactly as stored.** `resolveId` no longer re-roots a bare id
  under `nodes/`, which is what made every id from a flat-layout vault resolve to
  a document that does not exist. Callers migrating from `read_document` must
  pass the full id. A trailing `.md` and leading slashes are still stripped.
- **`context_import` output:** `created` → `published`, `checkpoint` added, and
  `failed` entries carry `id` (for the `ids` path) or `title` (for the
  `documents` path).
- **`context_update`:** `title` sets a new title instead of selecting the node —
  select by `id`. `tags` replaces rather than merges. A `null` metadata value
  clears that key. Publishing defaults to **false** when `status` names a
  non-published lifecycle value, since those are metadata transitions rather than
  content releases.
- **`reconstructVersion` refuses a version the history does not contain**, where
  it previously returned the nearest keyframe's content as though it were the
  version asked for.

Widening, not breaking: `agent`, `artifact` and `table` join `NODE_TYPES`, and
`TAG_PATTERN` accepts `:` so namespaced tags (`#dept:engineering`) validate. The
selector lexer does not tokenize `:` inside a tag yet, so namespaced tags are not
addressable in a query.

Also fixed — vault aliases matching `__proto__`, `constructor` or `prototype` are
rejected at every mutating registry entry point, and alias lookup uses an
own-property check. Reported by CodeQL (`js/prototype-polluting-assignment`).

## Part of Context Nest

The engine is the library layer. Most users reach it through one of these:

| Surface | What it is |
|---|---|
| [@promptowl/contextnest-cli](https://www.npmjs.com/package/@promptowl/contextnest-cli) | The `ctx` command — `ctx init`, `ctx query`, `ctx verify` |
| [@promptowl/contextnest-mcp-server](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server) | MCP server exposing 35 vault tools to Claude, Cursor, Gemini, and Copilot |
| [Claude integration](https://github.com/PromptOwl/ContextNest#mcp-server) | Drop-in MCP config for Claude Code and Claude Desktop |

## Links

- [Context Nest repo](https://github.com/PromptOwl/ContextNest)
- [Specification](https://github.com/PromptOwl/context-nest-spec)
- [Whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/)
- [PromptOwl](https://promptowl.ai)
- [Discord](https://discord.gg/fxcSQ5gq)

## License

AGPL-3.0. Commercial licensing available from [PromptOwl](https://promptowl.ai) for embedding without AGPL obligations.
