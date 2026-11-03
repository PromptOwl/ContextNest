# Context Nest — Grok Build plugin

> **Status:** **Built, instruction tier.** Rules and skills only, no lifecycle hooks. Grok ignores the output of every hook except `PreToolUse` ("For passive events, stdout is ignored"), so a hook cannot give the model retrieval results or sweep reports. Checked with Grok 1.0.70: `grok plugin validate` passes, and `grok inspect` lists the four skills.

Gives [Grok Build](https://docs.x.ai/build/overview) the Context Nest operating rules and the four portable skills. The agent drives the [`ctx`](../../packages/cli) CLI directly.

## Install

1. Install the plugin from a checkout of this repository:
   ```bash
   grok plugin install /absolute/path/to/ContextNest/plugins/grok --trust
   ```
   You can also add the repository as a marketplace: `grok plugin marketplace add /absolute/path/to/ContextNest`.
2. Enable the plugin (plugins are off by default): `grok plugin enable contextnest`.
3. Add the rules. Copy `plugins/grok/AGENTS.md` into the project `AGENTS.md`. Grok reads `AGENTS.md` from the working directory up to the repository root.
4. Trust the project, or Grok does not load `AGENTS.md`: launch with `--trust`, or run `/hooks-trust` once.
5. Run `grok inspect`. Expected result: `contextnest (user, enabled) 4 skills`, and `AGENTS.md` under "Project Instructions".

The skills also show as slash commands, for example `/contextnest-recall`.

## What you get

| File | Generated from |
| --- | --- |
| `AGENTS.md` | `plugins/shared/prompts/rules.md` |
| `skills/contextnest-recall` | `retriever.md` (digest mode and scout mode) |
| `skills/contextnest-capture` | `capture.md` |
| `skills/contextnest-curate` | `curate.md` |
| `skills/contextnest-structure` | `structure.md` |

All files come from `plugins/shared/` through `pnpm plugins:sync`. Do not edit them here. The marketplace entry is `.grok-plugin/marketplace.json` at the repository root.

## Not included

- Auto-retrieval on each prompt, the capture gate and the correction sweep. Add them if Grok lets a hook add context to the model.
- Grok also loads Claude Code plugins. If the Claude Code plugin is installed, Grok runs its hooks, but it ignores what they print. Use this plugin in Grok.
