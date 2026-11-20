# Context Nest — Muse Code

> **Status:** **Built, instruction tier.** Rules and skills only, no lifecycle hooks. Muse Code hooks run with a cleared environment, and their payload format is not documented. Thus the shared hook core is not wired in yet. Muse Code 1.4.24 passes `muse skills validate` for all five skills.

Gives [Muse Code](https://dev.meta.ai/docs/muse-code/extending) the Context Nest operating rules and skills. The agent drives the [`ctx`](../../../packages/cli) CLI directly.

## Install

1. Install the skills for your user:
   ```bash
   for s in plugins/shared/skills/*/; do muse skills install "$s" --scope user; done
   ```
   You can also copy the folders into `~/.agents/skills/`.
2. Add the rules. Copy `plugins/shared/rules/contextnest.md` into the project `AGENTS.md`, or into `~/.config/muse/AGENTS.md` for all projects.
3. Start a new session and trust the workspace.

Muse Code also discovers `~/.claude/skills` and `$CODEX_HOME/skills`. If the Codex plugin is installed, Muse Code finds the same skills there.

## What Muse Code reads

| File | Source |
| --- | --- |
| `rules/contextnest.md` | The operating rules. You copy this file into `AGENTS.md`. |
| `skills/contextnest-recall` | `prompts/retriever.md` (digest mode and scout mode) |
| `skills/contextnest-capture` | `prompts/capture.md` |
| `skills/contextnest-curate` | `prompts/curate.md` |
| `skills/contextnest-structure` | `prompts/structure.md` |
| `skills/contextnest-setup` | Written by hand |

Every agent reads these same files in `plugins/shared/`. `pnpm plugins:sync` fills the first four skill bodies from `prompts/`. Edit the prompt, not the skill.

## Not included

- Auto-retrieval on each prompt, the capture gate and the correction sweep. Add them when Muse Code documents its hook stdin and output fields. The Codex adapter (`plugins/shared/hooks/codex.js`) is the model to copy.
