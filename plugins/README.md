# Context Nest agent plugins

Plugins that make coding agents **vault-aware** (auto-retrieve relevant context) and
**self-maintaining** (auto-capture new knowledge), all by driving the existing
[`ctx`](../packages/cli) CLI.

```text
plugins/
├── shared/        Agent-agnostic core — the single source of truth (ctx-driving
│                  hook scripts + canonical agent/skill prompts).
├── claude-code/   Claude Code plugin (built). Hooks + agents + skill. ← install this
├── codex/         OpenAI Codex adapter (planned — README only).
└── gemini/        Gemini CLI adapter (planned — README only).
```

## How the pieces fit

`plugins/shared/core/*.js` is pure (stdin/env in, hook-output JSON out, shelling to
`ctx`) and imports no agent-specific API. Each agent plugin **vendors** a copy of that
core via the sync script, because installed Claude plugins can't read files outside
their own directory:

```bash
pnpm plugins:sync     # vendor shared/core + fill agent/skill prompt bodies
pnpm plugins:check    # CI guard — fails if any vendored copy drifts from shared/
```

Edit `plugins/shared/`, never the vendored `plugins/<agent>/core/` copies.

## Integration surface per agent

| Agent | Surface | Status |
| --- | --- | --- |
| Claude Code | `ctx` CLI via hooks + agents | **Built** |
| Codex | `ctx` CLI + the [MCP server](../packages/mcp-server) | Planned |
| Gemini CLI | MCP server + custom commands reusing `core/` | Planned |

See each subdirectory's README for specifics.
