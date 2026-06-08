# @promptowl/contextnest-mcp-server

**Governed context for your AI agents — not memory.**

**by [PromptOwl](https://promptowl.ai)** | [Website](https://promptowl.ai) | [Whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/) | [Specification](https://github.com/PromptOwl/context-nest-spec) | [Discord](https://discord.gg/fxcSQ5gq)

[![npm](https://img.shields.io/npm/v/@promptowl/contextnest-mcp-server.svg)](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![SOC 2 Type 2](https://img.shields.io/badge/SOC%202-Type%202-green.svg)](https://promptowl.ai)

MCP server for [Context Nest](https://github.com/PromptOwl/ContextNest) — gives AI agents direct access to your context vault via the [Model Context Protocol](https://modelcontextprotocol.io). Every node is typed, versioned, and hash-chained, so what the agent reads is **governed and auditable, not a fuzzy memory blob**. Supports all node types — documents, source nodes, and skill nodes. Exposes **19 tools** over stdio transport.

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

Or via environment variable:

```bash
CONTEXTNEST_VAULT_PATH=/path/to/vault contextnest-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `vault_info` | Get vault identity and configuration summary |
| `resolve` | Execute a selector query with graph traversal |
| `read_document` | Read a single document by URI or path |
| `list_documents` | List documents with optional type/status/tag filters |
| `search` | Full-text search with graph traversal |
| `read_pack` | Resolve and return a context pack |
| `document_format` | Get the document format spec (call before creating docs) |
| `create_document` | Create a new document (supports all types including skill nodes) |
| `update_document` | Update an existing document |
| `delete_document` | Delete a document and its version history |
| `publish_document` | Publish a document (bump version, checkpoint) |
| `read_index` | Return the context.yaml graph index |
| `read_version` | Reconstruct a specific version of a document |
| `verify_integrity` | Verify all hash chains in the vault |
| `list_checkpoints` | List recent checkpoints |

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
resolve({ selector: "type:skill + #engineering" })  → all engineering skills
list_documents({ type: "skill" })                    → all skill nodes
create_document({ type: "skill", trigger: "..." })   → create a new skill
```

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
