# Context Nest agent plugins

Plugins that make coding agents **vault-aware** (auto-retrieve relevant context) and **self-maintaining** (auto-capture new knowledge), all by driving the existing [`ctx`](../packages/cli) CLI.

```text
plugins/
├── shared/        The single source of truth, and the plugin root for every agent
│                  except Claude Code: hook core, prompts, skills, rules, one small
│                  manifest or adapter for each agent.
└── claude-code/   Claude Code plugin (built). Hooks + agents + skill. ← install this
```

## How the pieces fit

`plugins/shared/core/*.js` is pure (stdin/env in, hook-output JSON out, shelling to `ctx`) and imports no agent-specific API.

**One directory serves six agents.** Codex, Gemini/Antigravity, OpenCode, Grok Build, Muse Code and Zed all read `plugins/shared/` in place. Each agent has only a manifest, a hook map or an install step that points at the same `core/`, `skills/` and `rules/`. There is no copy for an agent, so there is nothing to keep in sync. To add an agent, add its manifest or adapter to `plugins/shared/`. Do not add a directory.

**Claude Code keeps its own directory.** It runs capture and curation as background agents, not as skills, and it loads every skill in its plugin root. An installed Claude plugin cannot read files outside its own directory, so `plugins/claude-code/` holds a vendored copy of the core:

```bash
pnpm plugins:sync     # vendor shared/core into claude-code + fill agent/skill prompt bodies
pnpm plugins:check    # CI guard — fails if a vendored copy drifts from shared/
```

Edit `plugins/shared/`, never the vendored `plugins/claude-code/core/` copy.

The sync also fills the skill bodies in `shared/skills/*` from `shared/prompts/*`, because the Claude Code agents use the same prompts. Hook messages name the Claude Code agents; `shared/rules/contextnest.md` maps each one to the matching skill.

## Integration surface per agent

| Agent | Surface | Reads | Status |
| --- | --- | --- | --- |
| Claude Code | `ctx` CLI via hooks + agents | `claude-code/` | **Built** |
| Codex | `ctx` CLI via lifecycle hooks (Claude-compatible) + skills + rules | `shared/.codex-plugin/plugin.json` | **Built** |
| Gemini CLI & Antigravity | `ctx` CLI via lifecycle hooks + skills + rules | `shared/plugin.json`, `shared/hooks.json` | **Built** |
| OpenCode | `ctx` CLI via in-process plugin hooks (OpenCode 1 and 2) + skills + rules | `shared/package.json` → `opencode/index.js` | **Built** |
| Grok Build | `ctx` CLI via rules + skills (hook output is ignored) | `shared/skills/plugin.json` | **Built** |
| Muse Code | `ctx` CLI via rules + skills (no hooks) | `shared/skills/`, installed by command | **Built** |
| Zed | `ctx` CLI via rules + skills (no hooks) | `shared/skills/`, copied by the user | **Built** |

See [`claude-code/README.md`](claude-code/README.md) and [`shared/docs/`](shared/docs) for the install steps of each agent.
