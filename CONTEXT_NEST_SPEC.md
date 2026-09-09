# Context Nest Specification

**Version**: 1.0
**Author**: ContextNest — PromptOwl, LLC
**Compatible with**: Obsidian, PromptOwl, any markdown editor
**File Extension**: `.md` (standard markdown)

---

## Abstract

This document is the technical specification for the Context Nest — an open format for structured, versioned context that feeds AI agents trusted knowledge. It defines the document format, addressable context scheme, selector grammar, link resolution behavior, integrity verification, and context source integration for live data hydration via external tools and MCP servers.

This specification is intended for developers building tools, integrations, or implementations that read and write Context Nest–compatible content.

---

## Table of Contents

1. [Document Format](#1-document-format)
2. [Selector Grammar](#2-selector-grammar)
3. [Context Packs](#3-context-packs)
4. [Addressable Context Scheme](#4-addressable-context-scheme)
5. [Context Index (context.yaml)](#5-context-index-contextyaml)
6. [Version History](#6-version-history)
7. [Nest Checkpoints](#7-nest-checkpoints)
8. [History and Checkpoint Integrity](#8-history-and-checkpoint-integrity)
9. [Context Injection and Tracing](#9-context-injection-and-tracing)
10. [INDEX.md Format](#10-indexmd-format)
11. [Configuration Files](#11-configuration-files)
12. [Compatibility Notes](#12-compatibility-notes)
13. [Validation](#13-validation)
14. [Extension Points](#14-extension-points)
15. [Open Source Components](#15-open-source-components)
16. [References](#16-references)

---

## 1. Document Format

### 1.1 File Structure

A Context Nest is a directory with the following layout. Two layout modes are supported:

#### Structured Layout (recommended)

```
my-context-nest/
├── CONTEXT.md                   # Vault identity & AI instructions
├── context.yaml                 # Auto-generated context index (see §5)
├── .context/                    # Configuration directory
│   └── config.yaml              # Nest configuration
├── nodes/                       # Context documents (flat or nested)
│   ├── api-design.md
│   ├── brand-guidelines.md
│   ├── onboarding-overview.md
│   └── .versions/               # Version history (see §6)
│       └── api-design/
│           ├── v1.md
│           └── history.yaml
├── sources/                     # Context source nodes (see §1.6, §1.9)
│   ├── current-sprint-tickets.md
│   ├── recent-pr-activity.md
│   └── .versions/
│       └── current-sprint-tickets/
│           └── history.yaml
├── packs/                       # Saved selector queries (see §3)
│   └── onboarding-basics.yml
├── syntax.yml                   # Selector syntax config (optional)
└── INDEX.md                     # Root index (auto-generated, see §10)
```

#### Obsidian-Compatible Layout

```
my-context-nest/
├── CONTEXT.md                   # Vault identity & AI instructions
├── context.yaml                 # Auto-generated context index
├── .context/                    # Configuration directory (optional)
│   └── config.yaml
├── engineering/
│   ├── INDEX.md                 # Folder index (auto-generated)
│   ├── api-design.md
│   └── architecture.md
├── sources/
│   ├── INDEX.md
│   ├── current-sprint-tickets.md
│   └── recent-pr-activity.md
├── product/
│   ├── INDEX.md
│   └── roadmap.md
└── decisions/
    ├── INDEX.md
    └── adr-001-database-choice.md
```

In Obsidian mode, any `.md` file anywhere in the vault is treated as a context node. Hidden directories (`.`-prefixed) and `node_modules` are skipped.

Every document is standard Markdown with YAML frontmatter. Documents follow the GitHub Markdown spec (version 0.29-gfm). The raw content is never mutated — all editor features (context links, tags, mentions, task checkboxes) are rendered via decoration, not transformation. This ensures documents round-trip without loss between any Markdown-compatible tool (VS Code, Obsidian, any text editor).

### 1.2 CONTEXT.md — Vault Identity

Every vault SHOULD have a `CONTEXT.md` file at its root. This file serves as:

1. **Vault identity** — Name, purpose, and scope of the knowledge base
2. **AI operating instructions** — Behavioral guidelines for AI agents consuming the vault

CONTEXT.md is loaded first by MCP tools and AI clients. It functions as a "vault-level system prompt" — the AI reads it before accessing any individual documents.

Example:

```markdown
---
title: "Engineering Knowledge Base"
---

# Engineering Knowledge Base

This vault contains technical documentation for the PromptOwl platform.

## How to Use This Vault

1. Read `.context/config.yaml` for nest configuration and folder descriptions
2. Read `INDEX.md` for a summary of all documents, their types, status, and tags
3. Use `context.yaml` to understand the document graph — relationships, hub documents, and external dependencies
4. Start with hub documents (highest inbound links) for broad context
5. Follow `contextnest://` links within documents to traverse related content
6. Use `contextnest://tag/{name}` to discover all documents sharing a topic
7. When resolving `type: source` nodes, follow the hydration instructions in the document body to fetch live data via the declared MCP servers or tools

## Operating Instructions

- Always cite sources by document path
- Prefer published documents over drafts
- Flag any information older than 90 days
- When answering questions, search the vault first using `contextnest://search/{query}`

## Source Hydration Rules

- Check `cache_ttl` before making external calls to avoid unnecessary requests
- If a source's MCP server is unreachable, inform the user which data is unavailable
- Follow the `depends_on` ordering declared in source node frontmatter
- Never call more than 3 external sources in parallel
```

### 1.3 Document Metadata

Each document carries its metadata in a YAML frontmatter section:

```yaml
---
title: "API Design Guidelines"
description: "REST API design standards for the platform"
type: document
tags:
  - "#engineering"
  - "#api"
  - "#guidelines"
status: published
version: 3
author: john.doe@example.com
created_at: 2024-01-15T10:30:00Z
updated_at: 2024-02-01T14:22:00Z
derived_from:
  - "contextnest://engineering/original-api-spec"
checksum: "sha256:a1b2c3..."
metadata:
  word_count: 1250
---

# API Design Guidelines

See [Architecture Overview](contextnest://engineering/architecture-overview) for context.
Maintained by @jane.smith with oversight from @team:engineering.
```

### 1.4 Required Fields

- `title`: Human-readable document title (1-200 characters)

### 1.5 Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | — | Brief document summary (1-500 characters) |
| `type` | NodeType | `"document"` | Content classification (see §1.6) |
| `tags` | string[] | `[]` | Tags with `#` prefix: `["#api", "#guide"]` |
| `status` | Status | `"draft"` | One of `draft`, `pending_review`, `approved`, `published`, `rejected` (see §1.5.1) |
| `version` | integer | `1` | Version number (>= 1) |
| `author` | string | — | Author identifier (e.g., email address) |
| `created_at` | ISO 8601 | file creation time | Creation timestamp |
| `updated_at` | ISO 8601 | file modification time | Last update timestamp |
| `derived_from` | string[] | — | `contextnest://` URIs of source documents this document was derived from |
| `checksum` | string | — | SHA-256 of the document body (all content after the closing `---` of the frontmatter, including the leading newline). Format: `sha256:<64 lowercase hex>` |
| `metadata` | object | `{}` | Extensible metadata (word_count, etc.) |
| `source` | object | — | Source metadata block. Present only on `type: source` nodes (see §1.9) |
| `skill` | object | — | Skill metadata block. Present only on `type: skill` nodes (see §1.10) |

### 1.5.1 Status Lifecycle

`status` is a five-value enum. Implementations MUST normalize the raw on-disk value to one of the canonical values before downstream processing (validation, retrieval, indexing).

| Canonical | Meaning | Surfaces to retrieval? |
|-----------|---------|-----------------------|
| `draft` | Editable scratch state. Default for new documents. | Only when the caller passes an explicit `includeDrafts` opt-in. |
| `pending_review` | Author submitted for review; reviewer has not yet signed off. | No — hidden from LLM, visible to stewards. |
| `approved` | Reviewer signed off; awaiting publish ceremony. | No — hidden until promoted to `published`. |
| `published` | Live, retrievable. | Yes — the only canonical status surfaced by default. |
| `rejected` | Terminal hide. The steward retired the document. | No — implementations MUST refuse `publishDocument` on a rejected document to prevent silent resurrection. |

**Aliases.** Implementations SHOULD accept synonyms from other systems and normalize them to canonical values at parse time. Lookup is case-insensitive. Unknown values fall back to `draft`. The reference implementation ships with:

| Canonical | Aliases |
|-----------|---------|
| `rejected` | `cancelled`, `canceled`, `archived`, `abandoned`, `deprecated`, `removed` |
| `draft` | `superseded`, `todo`, `pending`, `wip`, `new` |
| `pending_review` | `review`, `in_review`, `in-review`, `under_review`, `under-review`, `submitted`, `needs_review`, `needs-review`, `awaiting_review`, `awaiting-review` |
| `approved` | `ready`, `reviewed`, `accepted`, `signed_off`, `signed-off` |
| `published` | `active`, `live`, `released`, `final`, `shipped` |

The on-disk format always stores canonical values. Aliased values found on disk are auto-canonicalized the next time the document round-trips through a write or through the implementation's index-regeneration command (e.g. `ctx index`).

**Transitions.** No state machine is enforced. Any status may transition to any other (subject to the `rejected → *` revival path requiring an explicit status change before content edits land). Metadata-only transitions (e.g. `published → rejected`) MUST NOT cut a new version; only content-publishing operations bump `version` and emit a checkpoint.

**Legacy `superseded`.** Earlier drafts of this spec defined `superseded` as a fifth canonical value. It is no longer canonical. Implementations MUST treat a raw `status: superseded` value as an alias for `draft` per the table above.

### 1.6 Node Types

Every document has a `type` that classifies its content:

| Type | Description | Example |
|------|-------------|---------|
| `document` | General documentation, guides, overviews | Architecture overview, onboarding guide |
| `snippet` | Short, reusable text fragments | Email templates, boilerplate paragraphs |
| `glossary` | Term definitions and vocabulary | Company glossary, technical terms |
| `persona` | AI persona or agent behavior definitions | Customer support persona, technical writer |
| `prompt` | Prompt templates and instructions | System prompts, few-shot examples |
| `source` | Instructions for fetching live context from external services | Sprint tickets from Jira, PR activity from GitHub |
| `tool` | Tool documentation and usage guides | API integration guide, deployment workflow |
| `reference` | External references, links, citations | Research papers, industry standards |
| `skill` | Reusable agent procedures with triggers, inputs, and guard rails | PR review workflow, bug triage, RFC drafting |

The `source` type is described in detail in §1.9. The `skill` type is described in detail in §1.10.

### 1.7 Inline Syntax

Documents support the following inline constructs:

| Construct | Syntax | Description |
|-----------|--------|-------------|
| Context link | `[Title](contextnest://path)` or `[Title](contextnest://path#section)` | Reference to another document or section (see §4) |
| Tag | `#tag` | Shared taxonomy label |
| Mention | `@user` or `@team:name` | Attribution or team reference |
| Task checkbox | `- [ ]` or `- [x]` | Embedded work item (GFM syntax) |

**Context links** use the `contextnest://` URI scheme (see §4) for cross-referencing documents. Links to `type: source` nodes use the same syntax — the target's type determines how the agent interprets the resolved content, not how the link is formed:

```markdown
See [Architecture Overview](contextnest://engineering/architecture-overview) for context.
See [Error Handling](contextnest://engineering/api-design#error-handling) for the specific section.
See [v2 snapshot](contextnest://engineering/api-design@7) for the pinned version at checkpoint 7.
See [Current Sprint Tickets](contextnest://sources/current-sprint-tickets) for live data.
```

**Backlinks** — automatic tracking of what documents reference a given document — are maintained by the implementation by scanning all `contextnest://` hrefs across the nest. Backlinks apply equally to all node types including source nodes.

**Tags** in frontmatter use the `#` prefix: `tags: ["#api", "#security"]`. Obsidian users may omit the `#` in frontmatter — tools SHOULD normalize both formats.

**Mentions**: `@username` or `@team:teamname`

**Tasks**: Standard GFM task list syntax (`- [ ]` incomplete, `- [x]` completed).

### 1.8 File Naming Conventions

- Use kebab-case for file names: `api-design-guidelines.md`
- Title in frontmatter can have spaces: `title: "API Design Guidelines"`
- Context links use document path: `contextnest://nodes/api-design-guidelines`
- Resolution priority: title field > filename (kebab-case to title conversion)

### 1.9 Source Nodes

A source node is a markdown document whose body contains instructions for fetching live context from external services (MCP servers, REST APIs, CLIs, or other tool interfaces). Source nodes are first-class nodes in the context graph — they are authored, versioned, governed, and checksummed like any other node. They participate in the full lifecycle defined by this specification: selectors, packs, context links, backlinks, checkpoint pinning, and integrity verification.

The key distinction from other node types is how an agent interprets the content. When an agent resolves a `type: document` node, it reads the body as knowledge to absorb. When an agent resolves a `type: source` node, it reads the body as **instructions to follow** — what calls to make, in what order, with what parameters, and how to interpret the results. The markdown body is the instruction set. The agent is the execution engine.

#### 1.9.1 Source Frontmatter

Source nodes carry a `source` metadata block in frontmatter. This block contains the minimum structured data needed by the resolver, runtime, and `context.yaml` index. Execution logic — call sequencing, parameter values, conditional behavior, error handling, interpretation guidance — lives in the markdown body where the agent reads it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source.transport` | string | Yes | Protocol for the external call: `mcp`, `rest`, `cli`, `function` |
| `source.server` | string | No | Server name or identifier. For `mcp` transport, this MUST match a server declared in `.context/config.yaml` `servers` or `context.yaml` `external_dependencies` |
| `source.tools` | string[] | Yes | Tool or endpoint names the agent will invoke when following the body's instructions. Enables capability checking and indexing |
| `source.depends_on` | string[] | No | `contextnest://` URIs of source nodes that MUST be hydrated before this one. Creates `depends_on` edges in the relationship graph |
| `source.cache_ttl` | integer | No | Seconds the runtime MAY cache the hydrated result. Omit if results should not be cached |

The `source` block MUST be present when `type` is `source`. It MUST NOT be present on other node types.

**Design principle:** Frontmatter carries what machines index. The body carries what agents execute. The frontmatter tells the resolver "this is a source node that uses the Jira MCP server and depends on another source." The body tells the agent "call this tool with these parameters, then use the result like this."

#### 1.9.2 Source Node Examples

**Simple source — single tool call:**

```markdown
---
title: "Active Project Config"
type: source
tags:
  - "#config"
status: published
source:
  transport: mcp
  server: jira
  tools:
    - jira_get_project
  cache_ttl: 3600
---

# Active Project Config

This source provides the current project configuration from Jira.

## Fetch the project

Call `jira_get_project` with:

- `project_key`: "ENG"

The result contains the project name, lead, board ID, and active
sprint ID. These values are used by other source nodes that depend
on this one.

## If this call fails

This source is a dependency for several other sources. If Jira is
unreachable, tell the user that project data is unavailable and
that downstream sources (sprint tickets, backlog) cannot be hydrated.
```

**Multi-step source — sequential tool calls:**

```markdown
---
title: "Current Sprint Tickets"
type: source
tags:
  - "#engineering"
  - "#sprint"
status: published
version: 2
author: jane.smith@example.com
source:
  transport: mcp
  server: jira
  tools:
    - jira_get_active_sprint
    - jira_get_sprint_issues
  depends_on:
    - "contextnest://sources/active-project-config"
  cache_ttl: 300
---

# Current Sprint Tickets

This source provides live sprint data from Jira. Before fetching
tickets, you need the project configuration from the
[Active Project Config](contextnest://sources/active-project-config).
Use the `board_id` value from that result.

## Step 1: Get the active sprint

Call `jira_get_active_sprint` with:

- `board_id`: the value from the Active Project Config

From the result, note the `sprint_id` value.

## Step 2: Get the tickets

Call `jira_get_sprint_issues` with:

- `sprint_id`: the value from Step 1
- `status`: ["In Progress", "In Review"]

The result is the context to use. Each ticket has a key (ENG-XXXX),
summary, assignee, and current status.

## How to interpret this data

Tickets in "In Review" are awaiting code review and may be
unblocked soon. Tickets in "In Progress" are actively being
worked on. If a ticket has been "In Progress" for more than
5 days, it may be blocked — ask the user if they want details.

## If these calls fail

If Jira is unreachable, tell the user that live sprint data is
unavailable. If a cached result exists within the TTL window,
use that and note it may be stale.
```

**REST transport source:**

```markdown
---
title: "Service Health Status"
type: source
tags:
  - "#ops"
  - "#monitoring"
status: published
source:
  transport: rest
  server: statuspage
  tools:
    - GET /api/v2/summary.json
  cache_ttl: 60
---

# Service Health Status

This source provides the current health status of platform services.

## Fetch the status

Make a GET request to the StatusPage API:

- **Endpoint**: `https://status.acme.com/api/v2/summary.json`
- **Method**: GET
- **Authentication**: None required (public endpoint)

The response contains a `components` array. Each component has a
`name`, `status` (operational, degraded_performance, partial_outage,
major_outage), and `updated_at` timestamp.

## How to interpret this data

Focus on components with status other than "operational" — these
indicate active issues. If any component shows "major_outage",
this should be flagged immediately regardless of what the user asked.

## If this call fails

The status page itself may be down during major outages. If
unreachable, tell the user that health status is unknown and
suggest checking https://status.acme.com directly.
```

#### 1.9.3 Referencing Source Nodes

Source nodes are referenced using the same `contextnest://` URI syntax as any other node. No special link syntax is required:

```markdown
The live ticket data is available from the
[Current Sprint Tickets](contextnest://sources/current-sprint-tickets).
```

When a `contextnest://` link targets a `type: source` node, resolution returns the source document itself (markdown body and frontmatter). Hydration of the source — executing the described tool calls — is a separate step performed by the agent based on the source's instructions and surrounding context. A link to a source node is a reference to the source's instructions and framing, not a guarantee that the live data will be fetched.

Section anchors into source nodes work identically to other node types:

```markdown
See the interpretation guidance in
[Sprint Tickets — Interpretation](contextnest://sources/current-sprint-tickets#how-to-interpret-this-data).
```

The agent reads the surrounding prose to decide whether to hydrate the source. "The live ticket data is available from..." signals relevance. "For historical context, the team previously sourced data from..." signals the source may not need hydration right now.

#### 1.9.4 Cross-Source Dependencies

When a source node requires data from another source node as input, the dependency is declared in two places:

1. **Frontmatter `depends_on`** — Structured declaration for the resolver. The resolver reads this to compute hydration order (topological sort). Creates `depends_on` edges in the `context.yaml` relationship graph.

2. **Markdown body** — Natural-language instructions for the agent. The body describes what values the agent needs from the dependency and how to use them.

Both point to the same target. The frontmatter serves the resolver; the body serves the agent. If they diverge, validation (§13) SHOULD flag the inconsistency.

Example of a dependency chain:

```
sources/active-project-config    (no dependencies — hydrates first)
    ↓ depends_on
sources/current-sprint-tickets   (needs project config values)
    ↓ depends_on
sources/sprint-risk-analysis     (needs sprint ticket data)
```

The resolver hydrates in topological order: project config → sprint tickets → risk analysis. At each step, the agent has the upstream results available in its session context when it reads the downstream source's instructions.

Circular dependencies in the `depends_on` graph are invalid. Implementations MUST reject them at validation time (see §13).

#### 1.9.5 Source Result Lifecycle

Hydrated source results are **session-scoped** by default. They are not written to the nest, do not receive version numbers, and do not participate in the checkpoint or integrity mechanisms defined in §7 and §8.

The rationale: the context nest stores **authored knowledge**, not transient API responses. Source nodes are the authored, versioned, governed artifacts — they contain the instructions for fetching live data. The fetched results are session state managed by the agent or runtime, not knowledge managed by the nest.

**Caching**: Implementations MAY cache hydrated results outside the nest directory structure, governed by the `cache_ttl` declared in the source node's `source` block. Cache storage format and location are implementation-defined.

**Audit tracing**: Audit traces (§9) SHOULD record source hydration events including the `result_hash` (SHA-256 of the hydrated content) for provenance verification. Implementations requiring full result retention for compliance SHOULD store results in an external audit log, not in the nest node graph.

**Promotion to durable record**: When a hydrated result is reviewed by a human and promoted to a durable record, it SHOULD be authored as a standard `type: document` node with `derived_from` referencing the originating source node(s). The promoted document then participates in the normal versioning, checkpoint, and integrity lifecycle:

```yaml
---
title: "Sprint 42 Planning Summary"
type: document
tags:
  - "#sprint"
  - "#planning"
status: published
author: jane.smith@example.com
derived_from:
  - "contextnest://sources/current-sprint-tickets"
  - "contextnest://sources/recent-pr-activity"
metadata:
  generated_by: agent
  reviewed_by: jane.smith@example.com
  source_data_fetched_at: 2024-03-01T12:05:00Z
---
```

### 1.10 Skill Nodes

A skill node is a markdown document that defines a **reusable, governed procedure** for an AI agent. While source nodes tell agents *where to get data*, skill nodes tell agents *how to perform tasks*. Skills are first-class nodes — authored, versioned, checksummed, and queryable like any other node. They participate in selectors, packs, context links, and integrity verification.

The key distinction: when an agent resolves a `type: document` node, it reads knowledge. When it resolves a `type: skill` node, it reads **a procedure to follow** — what to do, in what order, with what constraints, and what output to produce.

#### 1.10.1 Skill Frontmatter

Skill nodes carry a `skill` metadata block in frontmatter. This block contains the structured data needed for discovery and invocation. The step-by-step procedure, examples, edge cases, and output templates live in the markdown body.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skill.trigger` | string | Yes | Natural language description of when this skill should be invoked |
| `skill.inputs` | array | No | Input parameters the skill accepts. Each entry: `{ name, type, description?, required?, default? }` |
| `skill.tools_required` | string[] | No | MCP tools or capabilities the agent needs to execute this skill |
| `skill.output_format` | string | No | Expected output format: `markdown`, `json`, `text`, or `code` |
| `skill.guard_rails` | string[] | No | Constraints or safety rules the agent MUST follow during execution |

Input parameter types: `string`, `number`, `boolean`, `array`, `object`.

#### 1.10.2 Skill Examples

**Engineering skill — code review:**

```yaml
---
title: "Summarize PR Changes"
type: skill
tags:
  - "#engineering"
  - "#code-review"
status: published
version: 1
skill:
  trigger: "when asked to review or summarize a pull request"
  inputs:
    - name: pr_url
      type: string
      description: "URL or number of the pull request"
      required: true
  tools_required:
    - gh_pr_view
    - gh_pr_diff
  output_format: markdown
  guard_rails:
    - "Do not approve or merge — only summarize and flag concerns"
    - "Always note if tests are missing for changed code paths"
---

# Summarize PR Changes

## Steps

1. Fetch the PR metadata using `gh_pr_view`
2. Fetch the diff using `gh_pr_diff`
3. Group changes by area
4. Flag potential issues

## Expected Output

A structured summary with overview, changes by area, concerns, and verdict.
```

**Operational skill — incident triage:**

```yaml
---
title: "Triage Bug Report"
type: skill
tags:
  - "#engineering"
  - "#bugs"
status: published
version: 1
skill:
  trigger: "when asked to triage or analyze a bug report"
  inputs:
    - name: bug_description
      type: string
      required: true
  tools_required: []
  output_format: markdown
  guard_rails:
    - "Always ask for reproduction steps if not provided"
    - "Never dismiss a bug without evidence it cannot occur"
---

# Triage Bug Report

## Steps

1. Parse the bug report for symptoms and reproduction steps
2. Assess severity (P0–P3)
3. Suggest investigation path and potential root causes
```

#### 1.10.3 Referencing Skill Nodes

Skill nodes are referenced using the same `contextnest://` URI syntax as any other node:

```markdown
For code review procedures, see
[Summarize PR Changes](contextnest://nodes/summarize-pr).
```

Skills are queryable by type: `ctx query "type:skill"` returns all skills. Combined with tags: `ctx query "type:skill + #engineering"` returns engineering skills.

#### 1.10.4 Skill Packs

Skills can be grouped into packs for distribution:

```yaml
id: engineering-skills
label: Engineering Skills
description: Reusable AI agent skills for engineering workflows
query: "type:skill + #engineering"
agent_instructions: >
  When a user request matches a skill trigger, follow the steps
  defined in that skill document rather than improvising.
```

Cloud-hosted skill packs (`ctx query @org/engineering-skills`) enable distribution of governed, versioned agent procedures without sharing source files.

#### 1.10.5 Skill vs Prompt Nodes

Both `type: prompt` and `type: skill` contain instructions for agents, but they serve different purposes:

| | Prompt | Skill |
|---|---|---|
| Purpose | Text template to fill in | Procedure to execute |
| Inputs | Template variables | Typed parameters with validation |
| Tools | None | May require MCP tools |
| Guard rails | None | Explicit constraints |
| Output | Filled template | Task result |

Use `prompt` for text generation templates. Use `skill` for multi-step procedures that may involve tool calls, have safety constraints, and produce structured output.

---

## 2. Selector Grammar

Context Nest defines a composable query language for selecting documents. Selectors are used by CLIs, MCP tools, and programmatic APIs. Selectors operate uniformly across all node types including source nodes.

### 2.1 Atoms

| Syntax | Name | Matches |
|--------|------|---------|
| `#tag` | Tag | Nodes where `tags` array contains `#tag` |
| `contextnest://path` | URI | Node at the given path (see §4) |
| `contextnest://tag/{name}` | Tag URI | All nodes carrying the given tag |
| `contextnest://folder/` | Folder URI | All nodes within the given folder |
| `contextnest://search/{query}` | Search URI | Nodes matching a full-text search query |
| `pack:id` | Pack reference | Expands a saved pack query (see §3) |
| `type:X` | Type filter | Nodes where `type == X` |
| `status:X` | Status filter | Nodes where `status == X` |
| `transport:X` | Transport filter | Source nodes where `source.transport == X`. Non-source nodes are excluded from results |
| `server:X` | Server filter | Source nodes where `source.server == X`. Non-source nodes are excluded from results |

### 2.2 Operators

| Operator | Name | Semantics |
|----------|------|-----------|
| `+` or implicit | AND | Intersection of result sets |
| `\|` | OR | Union of result sets |
| `-` | NOT | Set difference (left minus right) |
| `(` `)` | Grouping | Override precedence |

**Precedence** (highest to lowest): `()` > `+` (AND) > `-` (NOT) > `|` (OR)

Adjacent atoms without an explicit operator are implicitly ANDed:
```
#onboarding type:document    →    #onboarding + type:document
```

### 2.3 Examples

```bash
# By tag
ctx resolve "#onboarding"

# By tag URI
ctx resolve "contextnest://tag/onboarding"

# By document path
ctx resolve "contextnest://engineering/api-design"

# By folder
ctx resolve "contextnest://engineering/"

# Full-text search
ctx resolve "contextnest://search/rate+limiting"

# AND — intersection
ctx resolve "#onboarding + type:document"

# OR — union
ctx resolve "#brand | #glossary"

# NOT — exclusion
ctx resolve "#guide - #deprecated"

# Grouped
ctx resolve "(#onboarding | #brand) + status:published"

# Saved pack
ctx resolve "pack:onboarding.basics"

# Complex composition
ctx resolve "pack:onboarding.basics + contextnest://nodes/brand-one-pager - #deprecated"

# All source nodes tagged engineering
ctx resolve "type:source + #engineering"

# All MCP-based sources
ctx resolve "type:source + transport:mcp"

# All sources connected to the Jira server
ctx resolve "type:source + server:jira"

# Mix static docs and sources in one query
ctx resolve "#sprint + status:published"
```

---

## 3. Context Packs

Packs are saved selector queries stored as YAML files in the `packs/` directory. The `id` field is a bare slug (no `pack:` prefix); the selector grammar adds the `pack:` prefix when referencing it (e.g., `id: onboarding.basics` → referenced as `pack:onboarding.basics` in a selector).

Packs may include both static document nodes and source nodes. When a pack includes source nodes, the resolver hydrates them according to each source's `depends_on` ordering. The pack's `agent_instructions` field provides prose guidance for the agent on hydration behavior, priority, and failure handling.

### 3.1 Pack Format

```yaml
# packs/onboarding-basics.yml
id: onboarding.basics
label: "Onboarding Basics"
description: "Essential onboarding materials for new hires"
query: "#onboarding + type:document - #deprecated"
includes:
  - "contextnest://nodes/company-glossary"
excludes:
  - "contextnest://nodes/internal-roadmap"
filters:
  node_types:
    - document
    - glossary
audiences:
  - internal
  - agent
```

### 3.2 Packs with Source Nodes

When packs include source nodes, the `agent_instructions` field provides natural-language guidance for the agent. This keeps orchestration logic in prose rather than introducing an execution DSL into the pack format.

```yaml
# packs/sprint-standup.yml
id: sprint.standup
label: "Sprint Standup Context"
description: "Everything an agent needs to run a standup summary"

# Static context
query: "#sprint + type:document + status:published"

# Explicit includes — mix of documents and sources
includes:
  - "contextnest://engineering/team-roster"
  - "contextnest://sources/active-project-config"
  - "contextnest://sources/current-sprint-tickets"
  - "contextnest://sources/recent-pr-activity"

excludes:
  - "contextnest://sources/slack-standup-thread"

# Natural-language hydration guidance for the agent
agent_instructions: |
  Hydrate all included source nodes. The dependency ordering is
  declared in each source's frontmatter — follow it.

  If Jira or GitHub are unreachable, tell the user which data
  is missing rather than guessing.

  The Slack standup thread source is excluded by default. Only
  fetch it if the user specifically asks about async updates —
  in that case, resolve contextnest://sources/slack-standup-thread
  separately.

audiences:
  - internal
  - agent
```

The pack does not distinguish between document and source includes — they use the same `contextnest://` URIs. The resolver handles each according to its `type`. Source dependencies declared via `depends_on` are respected regardless of the order nodes appear in `includes`.

### 3.3 Pack Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Pack identifier slug (referenced as `pack:{id}` in selectors) |
| `label` | string | Yes | Human-readable name |
| `description` | string | No | Brief description of the pack's purpose |
| `query` | string | No | Selector query expression (§2) |
| `includes` | string[] | No | Additional `contextnest://` URIs to include beyond the query results |
| `excludes` | string[] | No | `contextnest://` URIs to exclude from the final result set |
| `filters.node_types` | string[] | No | Restrict results to specific node types |
| `agent_instructions` | string | No | Natural-language guidance for agents consuming this pack. Recommended when the pack includes source nodes |
| `audiences` | string[] | No | Intended audiences for this pack |

---

## 4. Addressable Context Scheme

Context Nest defines a URI scheme for addressing context. Agents and integrations request context by address.

### 4.0 Namespace and Federation Model

A **namespace** is a named, independently governed Context Nest. Namespaces allow multiple nests to coexist and reference each other without colliding on document paths.

#### Namespace Declaration

A nest declares its identity and federation posture in `context.yaml` (see §5). Three configurations are valid:

| `namespace` present | `federation` value | Meaning |
|---|---|---|
| No | absent or `none` | Anonymous local nest. All URIs resolve within this nest. Cross-namespace references are rejected. |
| Yes | `none` | Named isolated nest. The slug is informational; the nest does not accept inbound cross-namespace resolution. |
| Yes | `federated` | Open federation. This nest can resolve URIs targeting any other federated nest reachable via the registry. |
| Yes | `scoped` | Scoped federation. This nest can only resolve URIs targeting nests explicitly listed in its allow-list. |

If `federation` is `federated` or `scoped` and `namespace` is absent, implementations MUST reject the configuration at startup and MUST NOT serve any URI resolution until the issue is corrected.

#### Federation Modes

**`none` (default)**: The resolver ignores any authority component in incoming URIs. Every URI is treated as a local reference. This is the safe default for local development, single-project use, and air-gapped deployments.

**`federated`**: The resolver routes URIs whose authority component names a different namespace to the addressable context registry. The remote nest MUST also declare `federation: federated` and MUST be enrolled in the same registry. Resolution fails if either condition is not met.

**`scoped`**: Like `federated`, but the resolver additionally checks that the target namespace appears in a locally configured allow-list before forwarding the request. Nests not on the allow-list are treated as unreachable regardless of their registry enrollment.

#### context.yaml Scope

`context.yaml` indexes only the documents owned by this nest. Remote documents referenced via cross-namespace links are never added to the local `context.yaml`, regardless of federation mode. This boundary preserves independent governance: a remote author's publish decisions apply only within their own nest.

Cross-namespace links appear in the local `relationships` edge list as full `contextnest://{namespace}/{path}` URIs (see §5). Agents and resolvers treat these as deferred references — they are resolved on demand via the registry at query time, not at index time.

#### Anonymous URIs

A URI with no authority component (`contextnest://engineering/api-design`) always resolves within the current namespace — i.e., the nest whose resolver is handling the request. This rule applies in all federation modes. It preserves backward compatibility: documents authored without a namespace authority continue to resolve correctly in any deployment.

### 4.1 URI Format

```
contextnest://document_path
contextnest://document_path#section-anchor
contextnest://document_path@N
contextnest://document_path@N#section-anchor
contextnest://tag/{name}
contextnest://folder_path/
contextnest://search/{query}
```

| Pattern | Resolves To |
|---------|-------------|
| `contextnest://document_path` | Latest published version of the document (floating) |
| `contextnest://document_path#section-anchor` | A specific section within the latest published version (floating) |
| `contextnest://document_path@N` | The version of the document recorded at nest checkpoint N (pinned) |
| `contextnest://document_path@N#section-anchor` | A specific section within the pinned version at checkpoint N |
| `contextnest://tag/{name}` | All published documents carrying the given tag |
| `contextnest://folder_path/` | All published documents within the given folder |
| `contextnest://search/{query}` | All published documents matching the search query (full-text) |

All URI patterns apply equally to all node types. A URI targeting a `type: source` node resolves to the source document (frontmatter and markdown body). Hydration of the source — executing the described tool calls — is a separate step performed by the agent, not by the URI resolver.

Section anchors follow standard Markdown heading-to-anchor rules: lowercase, spaces replaced with hyphens (e.g., `## Error Handling` → `#error-handling`).

Search queries use `+` for spaces (e.g., `contextnest://search/rate+limiting`). Search is full-text against document title, description, tags, and body content. Search resolution behavior (ranking, fuzzy matching, etc.) is implementation-defined.

### 4.2 Resolution Behavior

**Floating** (no `@N`): Returns the latest published version of the target document(s). This is the default and appropriate for most authored cross-references.

**Pinned** (`@N`): Returns the document version recorded in checkpoint N's `document_versions` map in `.versions/context_history.yaml` (see §7). If the document was not published at that checkpoint, resolution returns null. Pinned resolution provides a checkpoint-consistent view of the entire graph, suitable for audit replay and reproducible agent queries.

When a pinned URI targets a source node, it returns the version of the *instructions* at that checkpoint — not a historical hydrated result. Hydrated results are session-scoped and are not stored in the nest (see §1.9.5).

In both cases, the access is logged for audit tracing (see §9.2).

### 4.3 URI Canonicalization

Before resolution, implementations MUST normalize every `contextnest://` URI to its canonical form. Two URIs that differ only in non-canonical representation MUST resolve identically.

#### Path Segments

- **Case**: Path segments are case-sensitive. `Engineering/API-Design` and `engineering/api-design` are distinct documents. Authors MUST use lowercase path segments. Implementations SHOULD warn on uppercase segments.
- **Trailing slash**: A trailing slash denotes a folder query (§4.1). A URI without a trailing slash denotes a document. Implementations MUST NOT treat `contextnest://engineering/` and `contextnest://engineering` as equivalent.
- **Dot segments**: Implementations MUST resolve `.` and `..` segments before resolution. A URI containing `..` that would escape the nest root MUST be rejected with an error.
- **Consecutive slashes**: Consecutive slashes (e.g., `engineering//api-design`) are invalid. Implementations MUST reject such URIs.
- **Percent-encoding**: Path segments MUST be percent-decoded before comparison. Only characters that require encoding per RFC 3986 §2.1 are permitted encoded; unnecessarily encoded characters MUST be decoded. Percent-encoding is case-insensitive during decoding (`%2F` and `%2f` are equivalent) but the canonical form uses uppercase hex digits.

#### Authority (Namespace)

- The authority component (namespace slug) is case-insensitive. `contextnest://ACME/docs` and `contextnest://acme/docs` MUST be treated as the same target namespace. Implementations MUST lowercase the authority before resolution and registry lookup.
- An absent authority component is equivalent to the current nest's namespace (see §4.0 Anonymous URIs). It is never canonicalized to an explicit authority.

#### Checkpoint Pin

- `@N` MUST be a non-negative integer with no leading zeros. `@07` is invalid; implementations MUST reject it.
- `@0` is reserved and MUST NOT be used. The first valid checkpoint number is 1.

#### Section Anchor

- Anchors follow GitHub Markdown heading-to-anchor rules: lowercase, spaces replaced with hyphens, all non-alphanumeric characters except hyphens stripped.
- An empty anchor (`#`) is invalid and MUST be rejected.
- Anchors are not percent-encoded; they are matched as plain strings against the rendered heading list of the resolved document.

#### Canonical Form Summary

The canonical form of a `contextnest://` URI is:

```
contextnest://<lowercase-authority>/<lowercase-path-segments>[@N][#anchor]
```

Where `<lowercase-authority>` is omitted for local (anonymous) references. Implementations MUST produce this form when serializing URIs to `context.yaml` or any stored artifact.

---

## 5. Context Index (context.yaml)

`context.yaml` is an auto-generated file at the root of the nest. It is the primary entry point for AI agents. Implementations MUST regenerate it whenever a document is published or its status changes. It MUST NOT be edited manually.

Tags in `context.yaml` are stored **without** the `#` prefix. Implementations MUST strip the leading `#` when writing the index (e.g., frontmatter `"#api"` → index `"api"`). This is consistent with the example below.

It contains the following sections:

- **`documents`** — registry of all published documents with their key metadata. For `type: source` nodes, entries include a `source` summary extracted from the node's frontmatter.
- **`relationships`** — flat edge list derived by extracting all `contextnest://` hrefs from published documents and all `depends_on` entries from source nodes. Each edge records the source document (`from`, always a bare local path), the target (`to`), and the edge type (`type`). The `to` format depends on whether the link is local or cross-namespace:
  - *Local link* — bare path, e.g. `engineering/architecture-overview`. Resolved directly within this nest.
  - *Cross-namespace link* — full URI including authority, e.g. `contextnest://platform/infra/networking`. Resolved on demand via the registry at query time; the remote document is never indexed in this nest's `context.yaml`.
  - The fragment is excluded from both formats; it is preserved only for section-level resolution at query time.
- **`hubs`** — the top documents by inbound reference count, pre-computed to give agents a high-signal starting point without loading the full graph.
- **`external_dependencies`** — declared external services (MCP servers, REST APIs, etc.) required by source nodes. Auto-generated from the intersection of `.context/config.yaml` `servers` and the servers actually referenced by published source nodes.

It also carries two optional namespace fields that govern URI resolution (see §4.0):

- **`namespace`** (optional) — the URL-safe slug that identifies this nest when referenced from other nests. Omitting this field declares the nest as anonymous; it cannot participate in federation.
- **`federation`** (optional, default `none`) — the federation mode for this nest. Valid values: `none`, `federated`, `scoped`. If federation is `federated` or `scoped`, `namespace` MUST be present.

```yaml
# Auto-generated. Do not edit manually.
version: 1
generated_at: 2024-03-01T12:00:00Z
checkpoint: 7
checkpoint_at: 2024-03-01T12:00:00Z
namespace: acme            # optional; omit for anonymous local nests
federation: none           # none (default) | federated | scoped

documents:
  - id: engineering/api-design
    title: API Design Guidelines
    type: document
    tags: [engineering, api]
    status: published
    version: 4

  - id: engineering/architecture-overview
    title: Architecture Overview
    type: document
    tags: [engineering]
    status: published
    version: 1

  - id: product/roadmap
    title: Product Roadmap
    type: document
    tags: [product]
    status: published
    version: 2

  - id: sources/active-project-config
    title: Active Project Config
    type: source
    tags: [config]
    status: published
    version: 1
    source:
      transport: mcp
      server: jira
      tools: [jira_get_project]
      cache_ttl: 3600

  - id: sources/current-sprint-tickets
    title: Current Sprint Tickets
    type: source
    tags: [engineering, sprint]
    status: published
    version: 2
    source:
      transport: mcp
      server: jira
      tools: [jira_get_board, jira_get_active_sprint, jira_get_sprint_issues]
      depends_on: [sources/active-project-config]
      cache_ttl: 300

  - id: sources/recent-pr-activity
    title: Recent PR Activity
    type: source
    tags: [engineering, github]
    status: published
    version: 1
    source:
      transport: mcp
      server: github
      tools: [github_list_pull_requests]
      cache_ttl: 600

relationships:
  - from: engineering/api-design
    to: engineering/architecture-overview
    type: reference
  - from: product/roadmap
    to: engineering/api-design
    type: reference
  - from: engineering/api-design
    to: contextnest://platform/infra/networking    # cross-namespace
    type: reference
  - from: sources/current-sprint-tickets
    to: sources/active-project-config
    type: depends_on
  - from: engineering/sprint-planning-process
    to: sources/current-sprint-tickets
    type: reference

hubs:
  - id: engineering/architecture-overview
    degree: 8
  - id: engineering/api-design
    degree: 5

external_dependencies:
  mcp_servers:
    - name: jira
      url: "https://mcp.atlassian.com/sse"
      used_by:
        - sources/active-project-config
        - sources/current-sprint-tickets
    - name: github
      url: "https://mcp.github.com/sse"
      used_by:
        - sources/recent-pr-activity
```

`context.yaml` carries only the current checkpoint number and timestamp. Full checkpoint history is stored separately in `.versions/context_history.yaml` (see §7) and is not sent to agents by default.

### 5.1 Relationship Edge Types

Each edge in the `relationships` list carries a `type` field:

| Edge Type | Meaning | Derived From |
|-----------|---------|-------------|
| `reference` | One document links to another via a `contextnest://` href in its body | Inline context links (§1.7) |
| `depends_on` | A source node requires another source to be hydrated first | `source.depends_on` frontmatter (§1.9.1) |

The `reference` type is the default. The `depends_on` type is automatically generated when a source node declares dependencies. A single pair of nodes may have both edge types if the source body also contains an inline link to its dependency (which is the recommended pattern per §1.9.4).

### 5.2 External Dependencies

The `external_dependencies` section declares all external services required by the nest's source nodes. It is derived automatically from the `source.transport`, `source.server`, and `source.tools` fields across all published source nodes, cross-referenced with the `servers` registry in `.context/config.yaml` (§11.1).

This section serves two purposes:

1. **Capability checking** — An agent or runtime reads `external_dependencies` on first contact with the nest to determine whether it has access to the required services. If a required MCP server is unavailable, the runtime can inform the agent before resolution begins.

2. **Dependency mapping** — The `used_by` list connects each service to the source nodes that depend on it. If a service becomes unavailable, the agent can determine exactly which source nodes are affected.

---

## 6. Version History

For tools that support versioning, version history is stored in `.versions/{document-name}/` alongside the live documents. Source nodes are versioned identically to all other node types — the `source` frontmatter block and the markdown body are both captured in version snapshots and diffs.

### 6.1 Storage Model

Version history uses a **keyframe + diff model** for efficiency:

- **Keyframe versions** (version 1, and every `keyframe_interval` versions thereafter, default 10): stored as a full Markdown snapshot file (`v1.md`, `v10.md`, ...).
- **All other versions**: stored as a unified diff from the previous version, recorded inline in `history.yaml`.
- **Reconstruction**: apply diffs forward from the nearest keyframe to reach any target version.

```
my-context-nest/
├── nodes/
│   ├── api-design.md              # Current version (always latest)
│   └── .versions/
│       └── api-design/
│           ├── v1.md              # Keyframe snapshot of version 1
│           ├── v10.md             # Keyframe snapshot of version 10
│           └── history.yaml       # Version metadata + inline diffs
├── sources/
│   ├── current-sprint-tickets.md  # Current version (always latest)
│   └── .versions/
│       └── current-sprint-tickets/
│           ├── v1.md              # Keyframe snapshot of version 1
│           └── history.yaml       # Version metadata + inline diffs
```

The live document is always the authoritative latest version; the `.versions/` folder is history only.

Implementations MUST be able to reconstruct any version by applying diffs forward from the nearest keyframe. Keyframe files are self-contained and safe to read without the diff chain.

### 6.2 history.yaml

Each version entry in `history.yaml` records:

- `version` — integer version number
- `keyframe` — `true` if a snapshot file exists for this version; omitted otherwise
- `diff` — unified diff from the previous version (omitted for keyframes)
- `edited_by` — author email
- `edited_at` — ISO 8601 timestamp of the edit
- `published_at` — ISO 8601 timestamp when this version was published; omitted if this version was never published (e.g., a draft superseded before publication)
- `note` — reason for change (optional)
- `content_hash` — SHA-256 of the entry's content (see §8)
- `chain_hash` — SHA-256 linking this entry to all previous entries (see §8)

`published_at` is the authoritative record used to reconstruct checkpoint history (see §7.3).

```yaml
# .versions/api-design/history.yaml
keyframe_interval: 10
versions:
  - version: 1
    keyframe: true
    edited_by: john.doe@example.com
    edited_at: 2024-01-15T10:30:00Z
    published_at: 2024-01-20T09:00:00Z
    note: "Initial draft"
    content_hash: sha256:3a7bd3e2360a3d29aa625ddc5b74dac9f9b5b393f7d1e6b5a0c4f2e8d1a3c5b7
    chain_hash:   sha256:f4c2b3a1d9e8f7c6b5a4d3e2f1c0b9a8d7e6f5c4b3a2d1e0f9c8b7a6d5e4f3c2
  - version: 2
    diff: |
      --- v1
      +++ v2
      @@ -5,3 +5,5 @@
       existing line
      +new line added
       another line
    edited_by: jane.smith@example.com
    edited_at: 2024-01-18T11:00:00Z
    published_at: 2024-01-22T14:00:00Z
    note: "Added authentication section"
    content_hash: sha256:9b2c1a4de5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
    chain_hash:   sha256:1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e0f2a4b6c8d0e
  - version: 3
    diff: |
      ...
    edited_by: john.doe@example.com
    edited_at: 2024-01-25T10:00:00Z
    note: "WIP rate limiting section"
    content_hash: sha256:c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4
    chain_hash:   sha256:2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2e4f6
  - version: 10
    keyframe: true
    edited_by: jane.smith@example.com
    edited_at: 2024-03-01T10:00:00Z
    published_at: 2024-03-01T12:00:00Z
    note: "Rate limiting finalized"
    content_hash: sha256:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
    chain_hash:   sha256:b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3
```

---

## 7. Nest Checkpoints

Per-document versioning alone cannot guarantee cross-link consistency: when Document B is re-published, any document that links to it immediately resolves to the new version. A **nest checkpoint** provides an atomic, immutable snapshot of the entire graph — the Context Nest equivalent of a Git commit.

### 7.1 Checkpoint Creation

Each time any document is published (including source nodes), implementations MUST:

1. Append the new checkpoint to `.versions/context_history.yaml`.
2. Regenerate `context.yaml` with the updated `checkpoint` and `checkpoint_at` fields.

### 7.2 Checkpoint History

`.versions/context_history.yaml` is an append-only log of all checkpoints. It MUST NOT be edited manually.

```yaml
# Auto-generated. Do not edit manually.
checkpoints:
  - checkpoint: 6
    at: 2024-02-15T09:30:00Z
    triggered_by: product/roadmap
    document_versions:
      engineering/api-design: 3
      engineering/architecture-overview: 1
      product/roadmap: 2
      sources/active-project-config: 1
      sources/current-sprint-tickets: 1
    document_chain_hashes:
      engineering/api-design: sha256:3a7bd3e2360a3d29...
      engineering/architecture-overview: sha256:7c9e1f3a5b2d4e6f...
      product/roadmap: sha256:1d3e5f7a9b2c4d6e...
      sources/active-project-config: sha256:8b4c2d6e0f3a5b7d...
      sources/current-sprint-tickets: sha256:c1d2e3f4a5b6c7d8...
    checkpoint_hash: sha256:2e4a6c8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f...
  - checkpoint: 7
    at: 2024-03-01T12:00:00Z
    triggered_by: sources/current-sprint-tickets
    document_versions:
      engineering/api-design: 4
      engineering/architecture-overview: 1
      product/roadmap: 2
      sources/active-project-config: 1
      sources/current-sprint-tickets: 2
    document_chain_hashes:
      engineering/api-design: sha256:b2c3d4e5f6a7b8c9...
      engineering/architecture-overview: sha256:7c9e1f3a5b2d4e6f...
      product/roadmap: sha256:1d3e5f7a9b2c4d6e...
      sources/active-project-config: sha256:8b4c2d6e0f3a5b7d...
      sources/current-sprint-tickets: sha256:d2e3f4a5b6c7d8e9...
    checkpoint_hash: sha256:9f1b3d5e7a9c1e3f5b7d9f1b3e5a7c9f1b3d5e7a9c1e3f...
```

Each checkpoint entry records:

- `checkpoint` — monotonically increasing integer
- `at` — ISO 8601 timestamp of the publication event
- `triggered_by` — document path whose publication created this checkpoint (may be a source node path)
- `document_versions` — map of every published document path to its version number at this instant (includes source nodes)
- `document_chain_hashes` — map of every published document path to the `chain_hash` of its recorded version at this instant (see §8.2)
- `checkpoint_hash` — integrity hash chaining this checkpoint to the previous one (see §8.3)

**Key properties:**

- Checkpoints are immutable once written.
- A checkpoint is created only on publication, not on draft saves.
- `context.yaml` carries only the latest checkpoint; the full history lives in `.versions/context_history.yaml`.
- Pinned link resolution (`contextnest://path@N`, see §4.1) loads `.versions/context_history.yaml` to look up the `document_versions` map at checkpoint N. For source nodes, this returns the instructions as authored at that checkpoint — not a historical hydrated result.

### 7.3 Checkpoint History Rebuild

If `.versions/context_history.yaml` is absent, corrupted, or pruned, implementations MUST be able to rebuild it from the per-document `history.yaml` files. The `published_at` field (§6.2) is the source of truth.

**Rebuild algorithm:**

1. Scan all `.versions/*/history.yaml` files across the nest (including under `sources/`).
2. Collect all `{document_path, version, published_at}` tuples where `published_at` is present.
3. Sort all tuples chronologically by `published_at` ascending.
4. Replay in order, maintaining a running `document_versions` map (initialized empty): for each tuple, update the map entry for `document_path` to `version`, then snapshot the full map.
5. Assign monotonically increasing checkpoint numbers starting from 1 in replay order.
6. Write the full checkpoint list to `.versions/context_history.yaml`.
7. Update `checkpoint` and `checkpoint_at` in `context.yaml` to match the last checkpoint produced.

**Tie-breaking**: If two publication events share an identical `published_at` timestamp, sort by `document_path` ascending (lexicographic), then by `version` ascending.

**Guarantee**: A rebuild from intact per-document `history.yaml` files produces a `context_history.yaml` equivalent to the original, provided no `published_at` timestamps were modified.

---

## 8. History and Checkpoint Integrity

### 8.1 Overview

History files (`history.yaml`) and the checkpoint log (`context_history.yaml`) are the audit backbone of a Context Nest. They are the source of truth for provenance, version reconstruction, and pinned link resolution (§4.1). Without integrity verification, a tampered history file can silently corrupt audit trails and mislead AI agents consuming pinned context.

ContextNest uses a SHA-256 hash chain to detect tampering. Every entry in a history file carries two fields:

- **`content_hash`** — SHA-256 of the entry's content (the keyframe snapshot file or the inline diff string)
- **`chain_hash`** — SHA-256 that cryptographically links this entry to all previous entries

If any entry is modified — including its content, author, timestamp, or position in the sequence — the chain breaks and verification returns a specific error.

Source nodes participate in this integrity model identically to all other node types. The `source` frontmatter block and the markdown body are both included in the document content that is hashed.

### 8.2 Document Version Integrity

#### content_hash

For each version entry in `history.yaml`:

- **Keyframe versions** (`keyframe: true`): `content_hash` = SHA-256 of the full text of the corresponding snapshot file (e.g., `v1.md`).
- **Diff versions**: `content_hash` = SHA-256 of the `diff` field value (the unified diff string).

Format: `sha256:<64-character lowercase hex>`.

#### chain_hash

```
chain_hash[n] = SHA-256(
  chain_hash[n-1] + ":" +
  content_hash[n] + ":" +
  version[n]      + ":" +
  edited_by[n]    + ":" +
  edited_at[n]
)
```

For the first version entry, `chain_hash[n-1]` is replaced by the genesis sentinel:

```
contextnest:genesis:v1
```

The SHA-256 input is the UTF-8 encoding of the above concatenation with `:` as the field separator.

**Rules:**

- Implementations writing `history.yaml` MUST compute and append both `content_hash` and `chain_hash` for every new version entry.
- Implementations MAY verify the chain on read. Verification failures MUST be surfaced to the caller and MUST NOT be silently ignored.
- `content_hash` and `chain_hash` fields MUST NOT be modified after they are written. History files are append-only.

### 8.3 Checkpoint Integrity

Each entry in `context_history.yaml` carries a `checkpoint_hash` that chains checkpoints together and binds the checkpoint chain to each document's version chain.

#### Canonical document_versions string

To produce a deterministic hash input from the `document_versions` map, serialize it as a JSON object with keys sorted alphabetically and no whitespace:

```
canonical_versions = JSON.stringify(document_versions, /* sorted keys */)
```

Example: `{"engineering/api-design":4,"engineering/architecture-overview":1,"product/roadmap":2,"sources/active-project-config":1,"sources/current-sprint-tickets":2}`

#### Cross-Chain Binding

Each checkpoint entry records `document_chain_hashes` — a map from every document path in `document_versions` to the `chain_hash` value of that document's history entry at the recorded version. This field cryptographically anchors the checkpoint chain to the per-document version chains.

To produce a deterministic hash input from the `document_chain_hashes` map, serialize it as a JSON object with keys sorted alphabetically and no whitespace:

```
canonical_chain_hashes = JSON.stringify(document_chain_hashes, /* sorted keys */)
```

#### checkpoint_hash

```
checkpoint_hash[n] = SHA-256(
  checkpoint_hash[n-1]    + ":" +
  checkpoint[n]           + ":" +
  at[n]                   + ":" +
  triggered_by[n]         + ":" +
  canonical_versions[n]   + ":" +
  canonical_chain_hashes[n]
)
```

For the first checkpoint entry, `checkpoint_hash[n-1]` is replaced by:

```
contextnest:genesis:v1
```

**Checkpoint Rules:**

- Implementations MUST compute and append `checkpoint_hash` when writing new checkpoint entries.
- Implementations MUST populate `document_chain_hashes` by reading the `chain_hash` of each document's recorded version from its `history.yaml` at write time.
- A verifier MUST confirm that each value in `document_chain_hashes` matches the `chain_hash` stored in the corresponding document's `history.yaml` at the recorded version. A mismatch indicates that a document's history was rewritten after the checkpoint was created, and MUST be reported as `cross_chain_mismatch`.
- Implementations MAY verify the checkpoint chain on read; failures MUST be surfaced to the caller.

### 8.4 Verification

Implementations MAY expose a verification command or API that:

1. Reads all `.versions/*/history.yaml` files across the nest (including under `sources/`).
2. For each entry, re-computes `content_hash` from the actual keyframe file or diff string and compares it to the stored value.
3. Re-computes the `chain_hash` sequence from the genesis sentinel and compares each value to the stored entry.
4. Reads `.versions/context_history.yaml` and for each checkpoint entry, confirms that each value in `document_chain_hashes` matches the `chain_hash` of the corresponding version in the document's `history.yaml`.
5. Re-computes the `checkpoint_hash` sequence (incorporating `canonical_chain_hashes`) and compares each value to the stored entry.
6. Returns a structured report listing any mismatches, including the affected version or checkpoint number and the type of mismatch (`content_hash_mismatch`, `chain_hash_mismatch`, `cross_chain_mismatch`, or `checkpoint_hash_mismatch`).

Verification is idempotent and read-only. A clean verification result produces no file changes.

### 8.5 Hash Algorithm

All hashes in this section use SHA-256 (FIPS 180-4).

| Property | Value |
|----------|-------|
| Algorithm | SHA-256 |
| Input encoding | UTF-8 |
| Output format | `sha256:<64-character lowercase hex>` |

The `sha256:` prefix identifies the algorithm and reserves space for future algorithm agility. When a future version of this specification adds support for additional algorithms, the prefix will change (e.g., `sha3-256:`). Verifiers MUST reject unknown prefixes rather than silently passing verification.

---

## 9. Context Injection and Tracing

### 9.1 Injection

Agents request context by address (see §4) or by selector query (see §2). The resolver returns only published content.

When a resolved result set includes `type: source` nodes, the resolver returns the source documents (frontmatter and markdown body). The agent reads the body to determine whether and how to hydrate the source by making external tool calls. The resolver does not execute tool calls — it returns documents; the agent acts on them.

For source nodes with `depends_on` declarations, the resolver SHOULD return them in topological order so that the agent encounters upstream dependencies before downstream sources.

### 9.2 Tracing

Every context access is logged. When an AI output is questioned, the audit trace provides:

- Which document was used
- Which version number
- Which nest checkpoint was current at the time of access
- Who authored it
- When it was last edited

This enables full provenance: "The agent used Document X, version 4, at nest checkpoint 7, last edited on [date]." The checkpoint number allows exact reconstruction of the full graph state the agent saw at that moment.

### 9.3 Source Hydration Tracing

When an agent hydrates a source node by executing the described tool calls, the trace SHOULD additionally record:

| Field | Type | Description |
|-------|------|-------------|
| `trace_type` | string | `source_hydration`, `source_cache_hit`, or `source_failure` |
| `source_ref` | string | `contextnest://` URI of the source node |
| `source_version` | integer | Version of the source node at time of hydration |
| `checkpoint` | integer | Nest checkpoint current at time of hydration |
| `tools_called` | string[] | Tool names actually invoked during hydration |
| `server` | string | Server name used for the calls |
| `result_hash` | string | SHA-256 of the hydrated result content. Format: `sha256:<64 hex chars>` |
| `result_size` | integer | Size of the hydrated result in characters |
| `cache_hit` | boolean | Whether the result was served from cache |
| `duration_ms` | integer | Wall-clock time for the hydration (optional) |
| `error` | string | Error message if hydration failed (optional, present only for `source_failure`) |

The trace records `result_hash`, not `result_content`. The trace proves *what was seen* without storing the full payload in the nest. Implementations requiring full result retention for compliance SHOULD store results in an external audit log (see §1.9.5).

This extends the provenance chain from knowledge through to action: "The agent resolved `pack:sprint.standup` → read 3 static docs at checkpoint 12 → hydrated `sources/current-sprint-tickets` via Jira MCP (cache miss, result hash `sha256:9f1b...`) → hydrated `sources/recent-pr-activity` via GitHub MCP (cache hit, 4m old) → generated summary."

Note: Audit logging format, storage, and analytics are implementation-defined. This section defines the fields that SHOULD be captured, not the storage format.

---

## 10. INDEX.md Format

INDEX.md files are auto-generated summaries of folder contents. Source nodes appear alongside other node types, identified by their `type` field:

```markdown
---
title: "Engineering Index"
type: index
auto_generated: true
generated_at: 2024-02-01T14:22:00Z
---

# Engineering

Technical documentation and architecture decisions.

## Documents

| Document | Type | Status | Tags | Updated |
|----------|------|--------|------|---------|
| [API Design Guidelines](contextnest://engineering/api-design) | document | published | #api #guidelines | 2024-02-01 |
| [Architecture Overview](contextnest://engineering/architecture-overview) | document | draft | #architecture | 2024-01-28 |
| [Company Glossary](contextnest://engineering/company-glossary) | glossary | published | #product | 2024-01-15 |

## Subfolders

- [Decisions](contextnest://engineering/decisions/) - Architecture Decision Records
- [Sources](contextnest://sources/) - Live context sources

## Statistics

- Total documents: 3
- Published: 2
- Draft: 1

## Tags in this folder

#api #architecture #guidelines #product
```

A `sources/INDEX.md` lists source nodes with their transport and server information:

```markdown
---
title: "Sources Index"
type: index
auto_generated: true
generated_at: 2024-03-01T12:00:00Z
---

# Sources

Live context sources for dynamic data hydration.

## Source Nodes

| Source | Transport | Server | Tools | Tags | Updated |
|--------|-----------|--------|-------|------|---------|
| [Active Project Config](contextnest://sources/active-project-config) | mcp | jira | jira_get_project | #config | 2024-02-01 |
| [Current Sprint Tickets](contextnest://sources/current-sprint-tickets) | mcp | jira | jira_get_board, jira_get_active_sprint, jira_get_sprint_issues | #engineering #sprint | 2024-03-01 |
| [Recent PR Activity](contextnest://sources/recent-pr-activity) | mcp | github | github_list_pull_requests | #engineering #github | 2024-02-15 |

## External Dependencies

- **jira** (MCP): Used by Active Project Config, Current Sprint Tickets
- **github** (MCP): Used by Recent PR Activity

## Statistics

- Total sources: 3
- Published: 3
```

---

## 11. Configuration Files

### 11.1 .context/config.yaml

```yaml
# Context Nest Configuration
version: 1
name: "Engineering Knowledge Base"
description: "Technical documentation and decisions"

# Default settings for new documents
defaults:
  status: draft

# Folder configurations (Obsidian-compatible layout)
folders:
  engineering:
    description: "Technical documentation"
  decisions:
    description: "Architecture Decision Records"
    template: adr
  sources:
    description: "Live context source definitions"

# External server registry
# Maps server names used in source node frontmatter to connection details.
# Source nodes reference servers by name (e.g., source.server: jira);
# this registry provides the URL and metadata for the runtime.
servers:
  jira:
    url: "https://mcp.atlassian.com/sse"
    transport: mcp
    description: "Jira project and issue tracking"
  github:
    url: "https://mcp.github.com/sse"
    transport: mcp
    description: "GitHub repository and PR data"
  slack:
    url: "https://mcp.slack.com/mcp"
    transport: mcp
    description: "Slack workspace messaging"
  statuspage:
    url: "https://status.acme.com/api/v2"
    transport: rest
    description: "Public service health status"

# Export settings (for PromptOwl sync)
sync:
  promptowl_data_room_id: "dr_abc123"  # Optional: linked data room
  auto_index: true                      # Auto-generate INDEX.md files
```

The `servers` block is the authoritative registry of external services available to source nodes. When a source node declares `source.server: jira`, the runtime resolves the connection URL from this registry. The `external_dependencies` section in `context.yaml` (§5) is auto-generated from the intersection of this registry and the servers actually referenced by published source nodes.

### 11.2 syntax.yml (Optional)

Allows customization of selector token syntax per vault:

```yaml
tokens:
  tag: "#{{tag}}"                        # Default
  pack_reference: "pack:{{pack_id}}"     # Default
```

---

## 12. Compatibility Notes

### 12.1 Obsidian Compatibility

- **Frontmatter**: Fully compatible with Obsidian Properties
- **Tags**: Standard `#tag` syntax (Obsidian prefers no `#` in frontmatter tags — tools normalize both)
- **Tasks**: Standard GFM task checkboxes
- **Additional fields**: Frontmatter fields (`type`, `status`, `source`, etc.) are ignored by Obsidian but preserved
- **Authors**: Standard email format, same as Obsidian `author` property
- **Context links**: `[Title](contextnest://path)` renders as a standard markdown link in Obsidian
- **Source nodes**: Render as regular markdown documents in Obsidian. The `source` frontmatter block appears in Obsidian's Properties panel as a nested object. The markdown body reads as a human-readable runbook describing the tool calls and their parameters

### 12.2 PromptOwl Compatibility

When imported to PromptOwl:
- `author` mapped to PromptOwl user identity
- `status` mapped to PromptOwl workflow states
- Version history imported if `.versions/` folder present
- Tags mapped to PromptOwl taxonomy
- Source nodes mapped to PromptOwl data connectors
- `servers` in config mapped to PromptOwl integration registry
- `external_dependencies` mapped to PromptOwl integration configuration

### 12.3 Git Compatibility

- All files are plain text, diff-friendly
- `.context/` folder should be committed
- `.versions/` folder optional (PromptOwl can reconstruct from git history)
- CONTEXT.md should be committed (vault identity)
- `context.yaml` may be `.gitignore`d if regenerated on each checkout
- Source nodes are plain markdown — they diff and merge cleanly. Changes to tool call instructions, parameters, or interpretation guidance produce readable diffs

---

## 13. Validation

A valid Context Nest document:

1. Has valid YAML frontmatter (between `---` delimiters)
2. Has a `title` field in frontmatter
3. Body is valid markdown (GitHub Markdown spec 0.29-gfm)
4. Context links use valid `contextnest://` URIs
5. Tags match the allowed pattern: `^#?[a-zA-Z][a-zA-Z0-9_-]*$`
6. If `type` is present, it MUST be one of the 8 defined node types
7. If `status` is present, it MUST be one of: `draft`, `published`
8. If `checksum` is present, it MUST match the pattern `sha256:<64 hex chars>`

### 13.1 Source Node Validation

In addition to the base validation rules, `type: source` nodes MUST satisfy:

9. The `source` block MUST be present in frontmatter
10. `source.transport` MUST be present and MUST be one of: `mcp`, `rest`, `cli`, `function`
11. `source.tools` MUST be present and MUST be a non-empty array of strings
12. If `source.server` is present, it SHOULD match a server name declared in `.context/config.yaml` `servers` or `context.yaml` `external_dependencies`
13. If `source.depends_on` is present, each entry MUST be a valid `contextnest://` URI
14. Each `source.depends_on` URI MUST resolve to a `type: source` node
15. The `depends_on` graph across all source nodes MUST be acyclic (no circular dependencies)
16. If `source.cache_ttl` is present, it MUST be a positive integer
17. The `source` block MUST NOT be present on nodes where `type` is not `source`

### 13.2 Skill Node Validation

In addition to the base validation rules, `type: skill` nodes MUST satisfy:

18. The `skill` block MUST be present in frontmatter
19. `skill.trigger` MUST be present and MUST be a non-empty string
20. If `skill.inputs` is present, each entry MUST have a `name` (string) and `type` (one of: `string`, `number`, `boolean`, `array`, `object`)
21. If `skill.output_format` is present, it MUST be one of: `markdown`, `json`, `text`, `code`
22. The `skill` block MUST NOT be present on nodes where `type` is not `skill`

### 13.3 Cross-Reference Validation

23. If a `type: source` node declares `depends_on` referencing source X, and the node's body contains an inline `contextnest://` link to X, implementations SHOULD NOT flag this as redundant — it is the recommended pattern (§1.9.4)
24. If a `type: source` node's body contains inline `contextnest://` links to other source nodes that are NOT listed in `depends_on`, implementations SHOULD emit a warning suggesting the dependency be declared in frontmatter

**Suggested MIME type**: `text/markdown; variant=context-nest`

---

## 14. Extension Points

Tools MAY extend the spec with:

- Additional frontmatter fields (prefixed with tool name: `promptowl_feature: value`)
- Additional config in `.context/` (e.g., `.context/promptowl.yaml`)
- Custom INDEX.md sections
- Custom selector syntax via `syntax.yml`
- Custom URI patterns under `contextnest://`
- Additional `source.transport` values beyond the four defined in this specification
- Additional fields within the `source` block (prefixed with tool name: `source.promptowl_timeout: 30`)
- Additional relationship edge types beyond `reference` and `depends_on`
- Additional trace types beyond the three defined in §9.3
- Additional entries in the `servers` registry in `.context/config.yaml`

---

## 15. Open Source Components

The following components are intended to be released as open source:

| Component | License | Description |
|-----------|---------|-------------|
| Specification (this document) | CC-BY-4.0 | Open protocol specification |
| Context Engine (`@promptowl/context-engine`) | AGPL-3.0 | Reference implementation of selectors, versioning, storage, and source node resolution |
| MCP Server (`@contextnest/mcp-server`) | AGPL-3.0 | Model Context Protocol server for vault access, including source dependency resolution and hydration relay |
| CLI (`contextnest-cli`) | AGPL-3.0 | Command-line tools for vault operations |
| Editor Extensions (TipTap) | Apache-2.0 | Decoration-based extensions for HashTag, Mention, TaskCheckbox, ContextLink |

The following components remain proprietary:

| Component | Description |
|-----------|-------------|
| Context resolution engine | Determines what context to inject, when, and with what transforms |
| Governance policy engine | Permissions, policies, approval workflows, and compliance |
| Audit logging and analytics | Usage tracking, provenance reporting, and compliance dashboards |
| Addressable context registry API | Platform API for namespace federation and third-party integrations |
| Source hydration runtime | Cache management, connection pooling, and failure recovery for source node hydration |
| Hootie Desktop | AI chat client with vault integration |
| VS Code Extension | IDE integration for vault authoring |

---

## 16. References

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — Anthropic
- [EU AI Act](https://eur-lex.europa.eu/eli/reg/2024/1689/oj) — Transparency Requirements
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) — AI RMF
- [GitHub Flavored Markdown Spec](https://github.github.com/gfm/) — Version 0.29-gfm
- [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) — Uniform Resource Identifier (URI): Generic Syntax
- [FIPS 180-4](https://csrc.nist.gov/publications/detail/fips/180/4/final) — Secure Hash Standard (SHA-256)
- [JSON Path — RFC 9535](https://www.rfc-editor.org/rfc/rfc9535) — JSONPath: Query Expressions for JSON

---

*ContextNest is a product of PromptOwl, LLC This specification covers components intended for open release under CC-BY-4.0. Proprietary components are identified in §15.*