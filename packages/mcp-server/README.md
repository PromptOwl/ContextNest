# @promptowl/contextnest-mcp-server

[![npm](https://img.shields.io/npm/v/@promptowl/contextnest-mcp-server.svg)](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![SOC 2 Type 2](https://img.shields.io/badge/SOC%202-Type%202-green.svg)](https://promptowl.ai)

MCP server for [Context Nest](https://github.com/PromptOwl/ContextNest) — gives AI agents direct access to your context vault via the [Model Context Protocol](https://modelcontextprotocol.io). Supports all node types including documents, source nodes, and skill nodes. Exposes **19 tools** over stdio transport.

## Install

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

## Links

- [Context Nest repo](https://github.com/PromptOwl/ContextNest)
- [Specification](https://github.com/PromptOwl/context-nest-spec)
- [PromptOwl](https://promptowl.ai)
- [Discord](https://discord.gg/fxcSQ5gq)

## License

AGPL-3.0
