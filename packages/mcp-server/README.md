# @promptowl/contextnest-mcp-server

**Governed context for your AI agents — not memory.**

**by [PromptOwl](https://promptowl.ai)** | [Website](https://promptowl.ai) | [Whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/) | [Specification](https://github.com/PromptOwl/context-nest-spec) | [Discord](https://discord.gg/fxcSQ5gq)

[![npm](https://img.shields.io/npm/v/@promptowl/contextnest-mcp-server.svg)](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![SOC 2 Type 2](https://img.shields.io/badge/SOC%202-Type%202-green.svg)](https://promptowl.ai)

MCP server for [Context Nest](https://github.com/PromptOwl/ContextNest) — gives AI agents direct access to your context vault via the [Model Context Protocol](https://modelcontextprotocol.io). Every node is typed, versioned, and hash-chained, so what the agent reads is **governed and auditable, not a fuzzy memory blob**. Supports all node types — documents, source nodes, and skill nodes. Exposes **35 tools** over stdio transport.

> **New in 2.0** — sixteen canonical `context_*` tools are generated straight from the engine's operation catalog, so this server, the `ctx` CLI and the PromptOwl cloud now advertise the same names, schemas and error codes. The older tools still work and are marked deprecated. See [Upgrading to 2.0](#upgrading-to-20).

## Install

Run it directly, no install:

```bash
npx -y @promptowl/contextnest-mcp-server /path/to/your/vault
```

Or install globally:

```bash
npm install -g @promptowl/contextnest-mcp-server
```

## Usage

### With Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "contextnest": {
      "command": "contextnest-mcp",
      "args": ["/path/to/your/vault"]
    }
  }
}
```

### With Claude Code

```bash
claude mcp add contextnest -- contextnest-mcp /path/to/your/vault
```

### With Gemini CLI

```bash
gemini mcp add contextnest -- contextnest-mcp /path/to/your/vault
```

### Standalone

```bash
contextnest-mcp /path/to/your/vault
```

The positional argument may also be a **registered alias** (see the CLI's
`ctx vault add`), in which case the path is looked up in the central registry
(`~/.contextnest/config.yaml`):

```bash
contextnest-mcp work
```

Or via environment variable:

```bash
# Absolute path
CONTEXTNEST_VAULT_PATH=/path/to/vault contextnest-mcp
# …or a registered alias (overrides the registry default)
CONTEXTNEST_VAULT=work contextnest-mcp
```

The vault is resolved with this precedence: `CONTEXTNEST_VAULT` (alias) →
`CONTEXTNEST_VAULT_PATH` (path) → positional argument (alias or path) → a vault
found above the current directory → the registry's default alias → the current
directory.

## Tools

### Canonical tools (`context_*`)

Name, description and input schema for each of these come from the engine's
operation catalog, so this surface cannot drift from the CLI or the cloud. Prefer
them over the legacy tools below.

| Tool | Description |
|------|-------------|
| `context_init` | Open a vault: its `CONTEXT.md` instructions, configuration, path, and what it holds (totals, counts by type and status, tag set). `include_nodes` to also list nodes |
| `context_nests` | List every nest in the central registry — alias, path, description, which is default, whether it exists |
| `context_get` | Read one node. `include_raw` for the exact stored bytes, `verify_checksum` to detect drift on read, `allow_rejected` to read a retired node |
| `context_list` | List nodes with type / status / tag filters. Takes an array of types, `include_retired`, `full`, `limit` |
| `context_search` | Full-text search with graph traversal |
| `context_query` | Selector query with graph traversal. `include_drafts` for authoring surfaces |
| `context_resolve` | Resolve a selector to full bodies within a token budget |
| `context_versions` | List a document's version history (new capability — nothing exposed this before) |
| `context_reconstruct` | Reconstruct a specific version. Refuses a version the history does not contain, instead of returning a neighbour's content |
| `context_packs` | List packs, each with its `includes` and `excludes` |
| `context_verify` | Verify every hash chain in the vault |
| `context_create` | Create a node. Mint your own `id`, keep it a draft with `publish: false`, set an initial `status`, record a `note`, or supply a full `skill` block |
| `context_update` | Update a node — rename via `title`, set `status`, stamp an explicit `version`, clear a metadata key by sending `null`. Defaults to *not* publishing when `status` names a non-published state |
| `context_publish` | Publish a node (bump version, seal checkpoint); takes a `note`, returns the `chain_hash` |
| `context_delete` | Delete a node and its version history; returns the deleted node's `title` |
| `context_import` | Bulk create-and-publish. Takes `documents` (title + content) and/or `ids` (files already in the vault, published as-is) — a mixed batch seals **one** checkpoint and regenerates the index **once** |

### Vault tools

| Tool | Description |
|------|-------------|
| `document_format` | Get the document format spec (call before creating docs) |
| `read_index` | Return the context.yaml graph index |
| `read_pack` | Resolve and return a context pack |
| `list_checkpoints` | List recent checkpoints |

### Deprecated tools

Registered and behaving exactly as before, so existing clients keep working. They
will be removed in a future major.

| Deprecated | Use instead |
|------|-------------|
| `vault_info` | `context_init` |
| `read_document` | `context_get` |
| `list_documents` | `context_list` |
| `search` | `context_search` |
| `resolve` | `context_resolve` |
| `read_version` | `context_reconstruct` |
| `verify_integrity` | `context_verify` |
| `create_document` | `context_create` |
| `update_document` | `context_update` |
| `publish_document` | `context_publish` |
| `delete_document` | `context_delete` |

### Drift Governance

When a live file drifts from its last-approved bytes, these tools capture and resolve the change without touching the canonical document or hash chain until approved:

| Tool | Description |
|------|-------------|
| `stage_drift_suggestion` | Capture an out-of-band edit as a staged suggestion under `_suggestions/` (does not modify canonical doc or chain) |
| `list_suggestions` | List all staged suggestions for a document |
| `approve_suggestion` | Apply a staged suggestion: patch, bump version, write new canonical bytes, archive under `_archive/approved/` |
| `reject_suggestion` | Reject a staged suggestion: archive under `_archive/rejected/`, emit a chain event (reason required for audit trail) |

Typical flow: `verify_integrity` detects drift → `stage_drift_suggestion` → `list_suggestions` → `approve_suggestion` or `reject_suggestion`.

### Selector Grammar

The `resolve` tool takes a selector. One-liner:

```
#tag  type:X  status:X  pack:id  contextnest://path   ·   combine with + (AND)  | (OR)  - (NOT)  ( ) to group
```

Example: `resolve({ selector: "(#api | #auth) + status:published - #deprecated" })`. Full grammar in the [specification](https://github.com/PromptOwl/context-nest-spec).

### Graph Traversal

The `resolve`, `search`, and `read_pack` tools support graph-aware queries:

- **`hops`** (number, default: 2) — Controls traversal depth from matched documents. More hops = more context loaded, slower. Fewer hops = faster, less context.
- **`full`** (boolean, default: false) — Bypass graph traversal and load all documents (legacy mode).

### Skill Nodes

Agents can discover and use skill nodes — governed procedures with triggers, inputs, and guard rails:

```
context_resolve({ selector: "type:skill + #engineering" })  → all engineering skills
context_list({ type: "skill" })                             → all skill nodes
context_create({ type: "skill", trigger: "..." })           → create a new skill
```

## Upgrading to 2.0

Nothing in your MCP client config changes. The old tools are all still
registered. Four things do change:

**`context_overview` is removed.** It returned counts and a node list.
`context_init` now returns everything it did *plus* the vault's `CONTEXT.md`
instructions, its configuration and its path — so opening a vault is one call
instead of two. `vault_info` is an alias for `context_init` now, which is what
that name always promised. Node lists are opt-in behind `include_nodes`.

**Document ids are taken exactly as stored.** A bare slug is no longer re-rooted
under `nodes/`. If you were passing `api-design` to `read_document` and relying on
it finding `nodes/api-design`, pass the full id to `context_get`. This is what
makes flat-layout vaults work at all — every id from one used to resolve to a
document that does not exist. A trailing `.md` and leading slashes are still
stripped.

**`context_import` output changed:** `created` → `published`, and `checkpoint` is
added. `failed` entries carry `id` (for the `ids` path) or `title` (for the
`documents` path), not `title` unconditionally.

**`context_update` semantics:** `title` now sets a *new* title rather than
selecting the node to update — select by `id`. `tags` replaces the tag set rather
than merging into it; send the merged set if you want the old behaviour. A `null`
metadata value clears that key.

Two long-standing filter bugs are fixed in `context_list`, which may return
results where it previously returned nothing: `status: "rejected"` could never
match, and `type: "document"` skipped every document that omitted the optional
`type` field. Tags now match with or without a leading `#` and regardless of case.

## Ecosystem

The MCP server is one of four ways into the same vault — same file format, same governed history:

| | What it is | Get it |
|---|---|---|
| **CLI** (`ctx`) | Build and query the vault from the terminal | [`@promptowl/contextnest-cli`](https://www.npmjs.com/package/@promptowl/contextnest-cli) |
| **MCP server** | Agent access over the Model Context Protocol (this package) | [`@promptowl/contextnest-mcp-server`](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server) |
| **Engine** | Core library — parsing, storage, versioning, graph traversal | [`@promptowl/contextnest-engine`](https://www.npmjs.com/package/@promptowl/contextnest-engine) |
| **PromptOwl cloud** | Hosted packs, marketplace, SSO, approvals, role-scoped publishing | [promptowl.ai](https://promptowl.ai) |

Drop the server into any MCP-capable agent — Claude Desktop, Claude Code, Cursor, Gemini CLI, Windsurf — to plug the same vault into your IDE or chat client.

## Links

- [Context Nest repo](https://github.com/PromptOwl/ContextNest)
- [Specification](https://github.com/PromptOwl/context-nest-spec)
- [Whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/)
- [PromptOwl](https://promptowl.ai)
- [Discord](https://discord.gg/fxcSQ5gq)

## License

AGPL-3.0 — your files, your agent, your vault. No vendor lock-in. Commercial licensing available when you want to embed; contact [PromptOwl](https://promptowl.ai).
