# @promptowl/contextnest-mcp-server

MCP server for [Context Nest](https://github.com/PromptOwl/ContextNest) — gives AI agents direct access to your context vault via the [Model Context Protocol](https://modelcontextprotocol.io). Supports all node types including documents, source nodes, and skill nodes.

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
