# Context Nest — Grok Build

> **Status:** **Built, instruction tier.** Rules and skills only, no lifecycle hooks. Grok ignores the output of every hook except `PreToolUse` ("For passive events, stdout is ignored"), so a hook cannot give the model retrieval results or sweep reports. Checked with Grok 1.0.70: `grok plugin validate` passes, and `grok inspect` lists the five skills and `AGENTS.md`.

Gives [Grok Build](https://docs.x.ai/build/overview) the Context Nest operating rules and skills. The agent drives the [`ctx`](../../../packages/cli) CLI directly.

## Install

1. Install the plugin from a checkout of this repository:
   ```bash
   grok plugin install /absolute/path/to/ContextNest/plugins/shared/skills --trust
   ```
   You can also add the repository as a marketplace: `grok plugin marketplace add /absolute/path/to/ContextNest`.
2. Enable the plugin (plugins are off by default): `grok plugin enable contextnest`.
3. Add the rules. Copy `plugins/shared/rules/contextnest.md` into the project `AGENTS.md`. Grok reads `AGENTS.md` from the working directory up to the repository root.
4. Trust the project, or Grok does not load `AGENTS.md`: launch with `--trust`, or run `/hooks-trust` once.
5. Run `grok inspect`. Expected result: `contextnest (user, enabled) 5 skills`, and `AGENTS.md` under "Project Instructions".

The skills also show as slash commands, for example `/contextnest-recall`.

## What Grok reads

Grok reads only `plugins/shared/skills/`. The manifest `skills/plugin.json` names that folder as the plugin, so Grok does not see the hooks of the other agents.

| File | Source |
| --- | --- |
| `rules/contextnest.md` | The operating rules. You copy this file into `AGENTS.md`. |
| `skills/contextnest-recall` | `prompts/retriever.md` (digest mode and scout mode) |
| `skills/contextnest-capture` | `prompts/capture.md` |
| `skills/contextnest-curate` | `prompts/curate.md` |
| `skills/contextnest-structure` | `prompts/structure.md` |
| `skills/contextnest-setup` | Written by hand |

Every agent reads these same files. `pnpm plugins:sync` fills the first four skill bodies from `prompts/`. Edit the prompt, not the skill. The marketplace entry is `.grok-plugin/marketplace.json` at the repository root.

## Not included

- Auto-retrieval on each prompt, the capture gate and the correction sweep. Add them if Grok lets a hook add context to the model.
- Grok also loads Claude Code plugins. If the Claude Code plugin is installed, Grok runs its hooks, but it ignores what they print. Use this plugin in Grok.
