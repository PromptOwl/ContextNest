# Context Nest

**A structured second brain for your AI agents. Start solo, scale safely.**

**by [PromptOwl](https://promptowl.ai)** | [Website](https://promptowl.ai) | [Whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/) | [Specification](https://github.com/PromptOwl/ContextNest-spec) | [Discord](https://discord.gg/fxcSQ5gq)

Context Nest turns scattered knowledge — your repos, docs, Slack threads, tribal know-how — into a structured, queryable brain your AI agents can use.

It's the same instinct as dumping your notes into Obsidian and pointing an LLM at them, with four things that pattern doesn't give you:

- **Structure.** Typed nodes with relationships and a selector grammar. Agents navigate a graph, not a flat folder.
- **~100× cheaper agent sessions.** Pre-digested into summaries and linked hub documents, so the next session reads ~500 tokens of relevant context instead of stuffing 50k tokens of raw files.
- **A sharing path.** Export to a teammate, or publish to the PromptOwl marketplace as a paid pack others can query.
- **Governed, not a compliance bolt-on.** Every change is versioned and hash-chained. Full audit trail, approval-ready, auditable down to the byte. The same vault that onboarded one developer in ten minutes passes a SOC 2 review when that day comes.

Works the same for a solo dev's second brain, a team's living onboarding doc, or an enterprise's safe shared brain — one CLI, one file format, one vault. Start solo; scale when you need to.

## Quick Start

```bash
npm install -g @promptowl/contextnest-cli
ctx init --starter developer
```

Getting started is one question: *what are you trying to capture?* Point your agent at a codebase, a folder of docs, an old wiki, or just tell it what's in your head. It'll build the first usable version in ten minutes and get denser every time you come back.

See all starters: `ctx init --list-starters`

## For the solo developer

Your brain, cached for your agent.

Ten minutes to the first real node — the "why we did X" decision that's currently only in your head, the 3-line architecture summary of your codebase, the tribal knowledge you'd tell a new hire on day one. Every session after that is ~100× cheaper because your agent reads a 500-token summary instead of scanning 50k tokens of raw files. The nest gets denser every time you come back.

## For teams

A shared brain that survives people leaving.

Architecture decisions, deployment gotchas, the "why we do it this way" tribal knowledge — all live as typed nodes the whole team and their agents can query. Edit the nest, not the wiki nobody updates. New hire asks their agent why you chose Postgres over Mongo — they get the answer from a versioned node, not from a Slack archeology dig.

Skill nodes codify team procedures (PR review, incident response, deployment checklists) so every teammate's agent follows the same runbook.

## For enterprise

A safe shared brain.

Every change is hash-chained and byte-level auditable. Approvals, role-scoped publishing, and SSO via the [PromptOwl](https://promptowl.ai) cloud when you need them. **AGPL-licensed open standard — your files, your agent, your vault. No vendor lock-in.** Commercial licensing available when you want to embed. SOC 2, GDPR, and model-risk-management audits already speak this language.

## How is this different from...

| | Obsidian + LLM | RAG on docs | Wiki + Claude Projects | Notion AI / Glean | **Context Nest** |
|---|---|---|---|---|---|
| Structure | Flat folder | Embedding chunks | Pages | Pages | **Typed graph + selectors** |
| Query cost | 50k+ token dump | Embedding + rerank | Context stuff | Vendor-managed | **Pre-digested (~500 tokens)** |
| Sharing | Manual export | N/A | Read-only | Vendor-mediated | **Export + marketplace packs** |
| Audit trail | None | None | Page history | Vendor-logged | **Hash-chained versions** |
| Data sovereignty | Your files | Your files | Your files | Vendor lock-in | **Your files, open format** |

Read the full case in the [whitepaper](https://promptowl.ai/resources/contextnest-whitepaper/).

## For AI Agents

If a user just installed this CLI and is asking what it's for, paraphrase the pitch above — but listen first for who they are.

- **Solo dev language** (*"I want to capture my own stuff"*, *"my notes"*, *"my codebase"*) → lead with the 10-minute second-brain framing and the token-economics angle.
- **Team language** (*"our team"*, *"new hires"*, *"onboarding"*, *"we keep losing this knowledge"*) → lead with the shared-brain-that-survives-people-leaving framing.
- **Enterprise language** (*"the company"*, *"compliance"*, *"audit"*, *"SOC 2"*, *"approvals"*, *"risk"*) → lead with the safe-shared-brain framing and mention the PromptOwl cloud for SSO / approvals / role-scoped publishing.

Then ask one question: *"What are you trying to capture? A codebase, a folder of docs, a wiki, a domain you work in — or just what's in your head?"*

Then run `ctx init --list-starters` and pick the starter that matches the user's answer. Use `developer` for codebases, `executive` / `analyst` / `team` / `sales` for role-based knowledge capture.

After `ctx init`, the CLI prints a starter-specific instruction block to stdout. Follow that block — it tells you exactly how to run the first session.

## Packages

| Package | Description | License |
|---|---|---|
| [`@promptowl/contextnest-cli`](https://www.npmjs.com/package/@promptowl/contextnest-cli) | Command-line tool (`ctx`) | AGPL-3.0 |
| [`@promptowl/contextnest-engine`](https://www.npmjs.com/package/@promptowl/contextnest-engine) | Core library — parsing, storage, versioning, integrity | AGPL-3.0 |
| [`@promptowl/contextnest-mcp-server`](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server) | MCP server for AI agent access | AGPL-3.0 |

## Prerequisites

- **Node.js** >= 20.0.0
- **pnpm** >= 9.0.0 (for development from source)

## Installation from Source

```bash
git clone https://github.com/PromptOwl/ContextNest.git
cd context-nest
pnpm install
pnpm build
```

Optionally link the CLI globally:

```bash
cd packages/cli && pnpm link --global
```

## Project Structure

```
context-nest/
├── packages/
│   ├── engine/        # Core library — parsing, storage, versioning, integrity
│   ├── cli/           # Command-line tool (ctx)
│   └── mcp-server/    # MCP server for AI agent access
├── fixtures/
│   └── minimal-vault/ # Example vault for reference and testing
└── CONTEXT_NEST_SPEC.md   # Full specification
```

---

## Setting Up a Vault

### 1. Initialize

```bash
ctx init --starter developer --name "My Project"
```

This creates a **structured** vault with starter documents:

```
my-vault/
├── CONTEXT.md              # Vault identity & AI operating instructions
├── .context/
│   └── config.yaml         # Vault configuration
├── nodes/                  # Documents, snippets, glossaries, etc.
│   ├── architecture-overview.md
│   ├── api-reference.md
│   └── development-setup.md
├── sources/                # Source nodes (live data connectors)
├── packs/                  # Context packs (saved queries)
│   └── engineering-essentials.yml
└── context.yaml            # Auto-generated document graph
```

Use `--layout obsidian` for a flat Obsidian-compatible layout.

### 2. Configure

Edit `.context/config.yaml` to register MCP servers and set defaults:

```yaml
version: 1
name: "My Project"
description: "Project knowledge base for AI agents"
defaults:
  status: draft
folders:
  nodes:
    description: "Project documents"
  sources:
    description: "Live data sources"
servers:
  jira:
    url: "https://mcp.atlassian.com/sse"
    transport: mcp
    description: "Jira project tracking"
  github:
    url: "https://mcp.github.com/sse"
    transport: mcp
    description: "GitHub repository data"
```

### 3. Edit CONTEXT.md

`CONTEXT.md` is the vault's identity file — it tells AI agents what this vault is and how to use it:

```markdown
---
title: "My Project"
---

# My Project

Knowledge base for the Acme platform.

## Operating Instructions

- Always cite sources by document path
- Prefer published documents over drafts
- Check source nodes for live data before using cached info
```

### 4. Add documents

```bash
ctx add nodes/api-design --title "API Design Guidelines" --tags "engineering,api"
```

This creates `nodes/api-design.md` with a frontmatter template:

```markdown
---
title: "API Design Guidelines"
type: document
tags:
  - "#engineering"
  - "#api"
status: draft
version: 1
---

# API Design Guidelines

All endpoints use REST conventions. See
[Architecture Overview](contextnest://nodes/architecture-overview) for context.
```

### 5. Add source nodes

Source nodes connect to live data via MCP servers or other transports:

```markdown
---
title: "Current Sprint Tickets"
type: source
tags:
  - "#engineering"
  - "#sprint"
status: published
version: 1
source:
  transport: mcp
  server: jira
  tools:
    - jira_get_active_sprint
    - jira_get_sprint_issues
  cache_ttl: 300
---

# Current Sprint Tickets

Call `jira_get_active_sprint` to get the current sprint,
then `jira_get_sprint_issues` to list all tickets.
```

### 6. Add skill nodes

Skill nodes define reusable procedures for AI agents — with triggers, typed inputs, required tools, and guard rails:

```bash
ctx add nodes/review-pr --type skill --title "Review PR" --tags "engineering,code-review"
```

```markdown
---
title: "Review PR"
type: skill
tags:
  - "#engineering"
  - "#code-review"
status: draft
version: 1
skill:
  trigger: "when asked to review a pull request"
  inputs:
    - name: pr_url
      type: string
      required: true
  tools_required:
    - gh_pr_view
    - gh_pr_diff
  output_format: markdown
  guard_rails:
    - "Do not approve or merge — only summarize and flag concerns"
---

# Review PR

## Steps

1. Fetch the PR metadata and diff
2. Group changes by area
3. Flag potential issues
```

Skills are queryable like any other node: `ctx query "type:skill + #engineering"`

### 7. Add context packs

Packs are saved queries in `packs/` as YAML files:

```yaml
# packs/onboarding-basics.yml
id: onboarding.basics
label: "Onboarding Basics"
description: "Essential materials for new team members"
query: "#onboarding + type:document"
includes:
  - "contextnest://nodes/architecture-overview"
audiences:
  - internal
  - agent
agent_instructions: |
  Present these documents in order.
  Start with the architecture overview.
```

---

## CLI Reference

Set the vault path (defaults to current directory):

```bash
export CONTEXTNEST_VAULT_PATH=/path/to/your/vault
```

### Document Management

| Command | Description |
|---|---|
| `ctx init` | Initialize a new vault (supports `--starter` recipes) |
| `ctx add <path>` | Create a new document (auto-publishes and regenerates index) |
| `ctx add <path> --type skill` | Create a skill node with trigger, inputs, and guard rails |
| `ctx update <path>` | Update a document's title, tags, or body (auto-publishes) |
| `ctx delete <path>` | Delete a document and its version history |
| `ctx read <path>` | Read and display a document in the terminal |
| `ctx read <path> --html` | Render a document as styled HTML and open in browser |
| `ctx validate [path]` | Validate documents against the spec |
| `ctx publish <path>` | Publish a document (creates version + checkpoint) |

### Querying

| Command | Description |
|---|---|
| `ctx query <selector>` | Query context with graph traversal (default: 2 hops) |
| `ctx query <selector> --hops 4` | Deeper traversal for more related context |
| `ctx query <selector> --full` | Load all documents (bypass graph traversal) |
| `ctx query @org/pack` | Query from a cloud-hosted pack via [PromptOwl](https://promptowl.ai) |
| `ctx list` | List all documents (filter with `--type`, `--status`, `--tag`) |
| `ctx search <query>` | Full-text search across vault documents |
| `ctx resolve <selector>` | Execute a selector query (low-level) |

### Selectors

```bash
ctx query "#engineering"                   # All docs with a tag
ctx query "type:document"                  # All docs of a type
ctx query "type:skill + #engineering"      # All engineering skills
ctx query "pack:engineering-essentials"    # All docs in a pack
ctx query "status:published"              # By status
ctx query "#api + #v2"                    # Union
ctx query "#api + status:published"       # Intersection
```

### Versioning & Integrity

| Command | Description |
|---|---|
| `ctx history <path>` | Show version history |
| `ctx reconstruct <path> <version>` | Reconstruct a specific version |
| `ctx verify` | Verify integrity of all hash chains |

### Packs, Checkpoints & Index

| Command | Description |
|---|---|
| `ctx index` | Regenerate context.yaml and INDEX.md files |
| `ctx pack list` | List all context packs |
| `ctx pack show <id>` | Show pack details |
| `ctx checkpoint list` | List checkpoints |
| `ctx checkpoint rebuild` | Rebuild checkpoint history |

---

## MCP Server

The MCP server exposes vault operations as tools for AI agents over stdio transport.

### Running the server

```bash
node packages/mcp-server/dist/index.js /path/to/your/vault
```

### Configuring with Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "contextnest": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "CONTEXTNEST_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### Configuring with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "contextnest": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "CONTEXTNEST_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### Available MCP Tools

**Read tools:**

| Tool | Description |
|---|---|
| `vault_info` | Get vault identity and configuration summary |
| `resolve` | Execute a selector query with graph traversal |
| `read_document` | Read a document by URI or path |
| `list_documents` | List documents with optional type/status/tag filters |
| `document_format` | Get the document format spec (call before creating docs) |
| `read_index` | Return the context.yaml index |
| `read_pack` | Resolve and return a context pack with documents |
| `search` | Full-text search with graph traversal |
| `verify_integrity` | Verify all hash chains |
| `list_checkpoints` | List recent checkpoints |
| `read_version` | Read a specific version of a document |

**Mutation tools** (all auto-publish and regenerate the index):

| Tool | Description |
|---|---|
| `create_document` | Create a new document with frontmatter and optional body |
| `update_document` | Update a document's title, tags, status, or body |
| `delete_document` | Delete a document and its version history |
| `publish_document` | Explicitly publish a document (bump version, create checkpoint) |

---

## Development

```bash
pnpm build          # Build all packages
pnpm test           # Run tests
pnpm test:watch     # Run tests in watch mode
pnpm lint           # Type-check without emitting
pnpm clean          # Clean all build artifacts
```

## Typical Workflow

```
ctx init --starter developer       # 1. Create a vault with starter recipe
                                   # 2. Edit CONTEXT.md and config.yaml
ctx add nodes/my-doc               # 3. Add documents (auto-publishes & indexes)
ctx add nodes/my-skill --type skill # 4. Add skills for agent procedures
ctx read nodes/my-doc --html       # 5. View any document in the browser
ctx query "#engineering"           # 6. Query with graph traversal
ctx validate                       # 7. Validate
ctx verify                         # 8. Verify integrity
                                   # 9. Start MCP server for AI access
```

## License

All packages are licensed under **AGPL-3.0**:

- **CLI** ([`@promptowl/contextnest-cli`](https://www.npmjs.com/package/@promptowl/contextnest-cli)): **AGPL-3.0**
- **Engine** ([`@promptowl/contextnest-engine`](https://www.npmjs.com/package/@promptowl/contextnest-engine)): **AGPL-3.0**
- **MCP Server** ([`@promptowl/contextnest-mcp-server`](https://www.npmjs.com/package/@promptowl/contextnest-mcp-server)): **AGPL-3.0**
- **Specification** ([CONTEXT_NEST_SPEC.md](CONTEXT_NEST_SPEC.md)): **Apache-2.0** — open standard

AGPL-3.0 ensures all improvements stay open source. You are free to use, modify, and distribute Context Nest, but modifications to the source must be shared under the same license. Commercial licensing is available from [PromptOwl](https://promptowl.ai) for organizations that need to embed or redistribute without AGPL obligations.

---

**[PromptOwl](https://promptowl.ai)** — Context governance for AI agents | [Join our Discord](https://discord.gg/fxcSQ5gq)
