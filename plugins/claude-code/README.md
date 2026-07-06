# Context Nest — Claude Code plugin

Makes any Claude Code session **vault-aware** and **self-maintaining**:

- **Auto-retrieval** — a `UserPromptSubmit` hook pulls relevant vault material into
  each prompt (effort-toggled), so Claude answers from your governed knowledge base.
- **Auto-capture** — a `Stop` hook triggers a capture agent at the end of substantive
  turns to persist new facts, decisions, and gotchas back into the vault.
- **Session overview** — a `SessionStart` hook injects a compact list of your vaults.

Everything runs through the existing [`ctx`](../../packages/cli) CLI internally — no
MCP wiring required.

## Requirements

The Context Nest CLI must be available. Either install it globally:

```bash
npm i -g @promptowl/contextnest-cli
```

…or leave it — the plugin falls back to `npx -y @promptowl/contextnest-cli` (slower
cold start). Node ≥ 20 is required.

## Install

```text
/plugin marketplace add promptowl/contextnest      # this repo
/plugin install contextnest
```

On enable you'll be prompted for four settings (all optional):

| Setting | Default | Meaning |
| --- | --- | --- |
| **Retrieval effort** | `search` | `off` · `search` (cheap) · `query` (graph) · `agent` (full reasoning) |
| **Auto-capture** | `true` | Persist new knowledge at end of turn |
| **Pinned vault** | _(empty)_ | A registered vault alias. Empty → the agents pick the relevant vault(s) automatically |
| **ctx binary** | `ctx` | Override the CLI command |

## Components

| Type | Name | Role |
| --- | --- | --- |
| Hook | `SessionStart` | Inject vault overview (or a warning if `ctx` is missing) |
| Hook | `UserPromptSubmit` | Effort-toggled retrieval injection |
| Hook | `Stop` | Loop-safe gate that triggers capture |
| Agent | `contextnest-retriever` | Selects vault(s), builds a selector, runs `ctx query`, returns a cited digest |
| Agent | `contextnest-capture` | Dedupes then writes new nodes via `ctx add`/`ctx update` |
| Skill | `/contextnest:recall <topic>` | Manual deep retrieval |

## Local development

The `core/` directory is **vendored** from [`plugins/shared/`](../shared) — do not edit
it here. Change the source and re-sync from the repo root:

```bash
pnpm plugins:sync          # regenerate vendored core + agent/skill bodies
pnpm plugins:check         # verify no drift (used in CI)
claude --plugin-dir ./plugins/claude-code --debug
```
