# Context Nest agent plugins

Plugins that make coding agents **vault-aware** (auto-retrieve relevant context) and **self-maintaining** (auto-capture new knowledge), all by driving the existing [`ctx`](../packages/cli) CLI.

```text
plugins/
├── shared/        Agent-agnostic core — the single source of truth (ctx-driving
│                  hook scripts + canonical agent/skill prompts).
├── claude-code/   Claude Code plugin (built). Hooks + agents + skill. ← install this
├── codex/         OpenAI Codex plugin (built). Hooks + skills + rules.
├── gemini/        Gemini CLI & Antigravity adapter (built). Hooks + skills + rules.
├── opencode/      OpenCode plugin (built). In-process hooks + skills + rules.
├── grok/          Grok Build (built, instruction tier). Skills + AGENTS.md.
└── zed/           Zed Agent (built, instruction tier). AGENTS.md + skills.
```

## How the pieces fit

`plugins/shared/core/*.js` is pure (stdin/env in, hook-output JSON out, shelling to `ctx`) and imports no agent-specific API. Each agent plugin **vendors** a copy of that core via the sync script, because installed Claude plugins can't read files outside their own directory:

```bash
pnpm plugins:sync     # vendor shared/core + fill agent/skill prompt bodies
pnpm plugins:check    # CI guard — fails if any vendored copy drifts from shared/
```

Edit `plugins/shared/`, never the vendored `plugins/<agent>/core/` copies.

The sync also renders the portable skills (`shared/skills/*`, filled from
`shared/prompts/*`) and the operating rules (`shared/prompts/rules.md`) into each
plugin that has no agents of its own: Gemini, Codex, OpenCode, Grok and Zed. Hook messages name
the Claude Code agents; the rules map each one to the matching skill.

## Integration surface per agent

| Agent | Surface | Status |
| --- | --- | --- |
| Claude Code | `ctx` CLI via hooks + agents | **Built** |
| Codex | `ctx` CLI via lifecycle hooks (Claude-compatible) + skills + rules | **Built** |
| Gemini CLI & Antigravity | `ctx` CLI via lifecycle hooks + skills + rules | **Built** |
| OpenCode | `ctx` CLI via in-process plugin hooks (OpenCode 1 and 2) + skills + rules | **Built** |
| Grok Build | `ctx` CLI via `AGENTS.md` rules + skills (hook output is ignored) | **Built** |
| Zed | `ctx` CLI via `AGENTS.md` rules + skills (no hooks) | **Built** |

See each subdirectory's README for specifics.
