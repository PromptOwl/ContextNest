# Context Nest — Codex plugin

> **Status:** **Built.** Written against the [Codex hooks contract](https://developers.openai.com/codex/hooks). Unit-tested with a fake `ctx`; validate in a live Codex session before you rely on it. `node` (>= 20) must be on `PATH`.

Makes a Codex session **vault-aware** (auto-retrieval on each prompt) and **self-maintaining** (governed capture and correction sweeps). It drives the [`ctx`](../../packages/cli) CLI directly. No MCP setup is necessary.

## Install

```bash
codex plugin marketplace add promptowl/contextnest
codex plugin add contextnest@contextnest
```

1. Run `codex` and open `/hooks`.
2. Review and trust the four Context Nest hooks.
3. Start a new thread.

## What it does

Codex uses the same hook contract as Claude Code, so the plugin runs the same shared core as the Claude Code plugin. Only `hooks/codex.js` is specific to Codex.

| Hook | Core module | Behavior |
| --- | --- | --- |
| `SessionStart` | `session-start` | Injects the vault overview, the structure blueprint and `rules/contextnest.md`. |
| `UserPromptSubmit` | `retrieve` | Searches the vault for the prompt. Hands over a job that the last `Stop` parked. |
| `PostToolUse` (`Bash`) | `sweep-check` | After a `ctx update`, reports each node that still carries the removed value. |
| `Stop` | `capture-gate` | Parks a capture or change job for the next prompt. It returns no output, because Codex shows a `systemMessage` as a warning. |

The hook messages name the Claude Code agents. The rules map each agent to a skill:

| Skill | Shared prompt |
| --- | --- |
| `contextnest-recall` | `retriever.md` (digest mode and scout mode) |
| `contextnest-capture` | `capture.md` |
| `contextnest-curate` | `curate.md` |
| `contextnest-structure` | `structure.md` |

## Layout

```text
plugins/codex/
├── .codex-plugin/plugin.json   # Codex manifest (skills + hooks)
├── hooks/hooks.json            # Calls hooks/codex.js through `node -e` and PLUGIN_ROOT (works on Windows)
├── hooks/codex.js              # Adapter: rules injection + Codex rollout transcript reader
├── core/                       # Vendored from plugins/shared/core. Do not edit.
├── rules/contextnest.md        # Generated from plugins/shared/prompts/rules.md
└── skills/                     # Generated from plugins/shared/skills + prompts
```

The marketplace entry is `.agents/plugins/marketplace.json` at the repository root.

## Configuration

Codex has no `userConfig`. Set environment variables, or put the same keys (`retrieval_mode`, `capture_mode`, `vault`, ...) in `~/.contextnest/plugin-settings.json`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTNEST_RETRIEVAL_MODE` | `search` | `off` \| `search` \| `query` \| `agent` |
| `CONTEXTNEST_CAPTURE_MODE` | `propose` | `off` \| `propose` \| `auto` |
| `CONTEXTNEST_VAULT_ALIAS` | _(none)_ | Pinned vault alias |
| `CONTEXTNEST_UNCLEAR_NEST` | `ask` | `ask` \| `default` |
| `CONTEXTNEST_CTX_COMMAND` | `ctx` | The `ctx` binary |

## Limits

- Codex calls its rollout transcript format unstable. The `Stop` reader uses three record shapes only. If the format changes, ambient capture becomes quieter. Explicit asks ("remember this") use the typed prompt record.

## Verification

```bash
pnpm test plugins/__tests__/codex-adapter.test.ts
pnpm plugins:check
```
