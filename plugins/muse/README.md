# Context Nest — Muse Code plugin

> **Status:** **Built, instruction tier.** Rules and skills only, no lifecycle hooks. Muse Code hooks run with a cleared environment, and their payload format is not documented. Thus the shared hook core is not wired in yet.

Gives [Muse Code](https://dev.meta.ai/docs/muse-code/extending) the Context Nest operating rules and the four portable skills. The agent drives the [`ctx`](../../packages/cli) CLI directly.

## Install

1. Install the skills for your user:
   ```bash
   for s in plugins/muse/skills/*/; do muse skills install "$s" --scope user; done
   ```
   You can also copy the folders into `~/.agents/skills/`.
2. Add the rules. Copy `plugins/muse/AGENTS.md` into the project `AGENTS.md`, or into `~/.config/muse/AGENTS.md` for all projects.
3. Start a new session and trust the workspace.

Muse Code also discovers `~/.claude/skills` and `$CODEX_HOME/skills`. If the Codex plugin is installed, Muse Code finds the same skills there.

## What you get

| File | Generated from |
| --- | --- |
| `AGENTS.md` | `plugins/shared/prompts/rules.md` |
| `skills/contextnest-recall` | `retriever.md` (digest mode and scout mode) |
| `skills/contextnest-capture` | `capture.md` |
| `skills/contextnest-curate` | `curate.md` |
| `skills/contextnest-structure` | `structure.md` |

All files come from `plugins/shared/` through `pnpm plugins:sync`. Do not edit them here.

## Not included

- Auto-retrieval on each prompt, the capture gate and the correction sweep. Add them when Muse Code documents its hook stdin and output fields. The Codex adapter (`plugins/codex/hooks/codex.js`) is the model to copy.
