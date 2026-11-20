# Context Nest — Zed

> **Status:** **Built, instruction tier.** Rules and skills only, no lifecycle hooks. The Zed Agent has no hook API, so the shared hook core is not wired in.

Gives the [Zed Agent](https://zed.dev/docs/ai/agent-panel) the Context Nest operating rules and skills. The agent drives the [`ctx`](../../../packages/cli) CLI directly.

## Install

1. Install the skills for your user. Zed reads [skills](https://zed.dev/docs/ai/skills) from `~/.agents/skills/`, one folder for each skill. The loop copies the skill folders only:
   ```bash
   mkdir -p ~/.agents/skills
   for s in plugins/shared/skills/*/; do cp -R "${s%/}" ~/.agents/skills/; done
   ```
   For one project only, copy the folders into `<project>/.agents/skills/`. Zed loads project skills and `.zed/settings.json` only from a trusted worktree. A new folder opens in Restricted Mode: click the exclamation mark icon in the title bar, or run `workspace: toggle worktree security`, then trust it.
2. Add the rules. Copy `plugins/shared/rules/contextnest.md` into the project `AGENTS.md`, or into `~/.config/zed/AGENTS.md` for all projects. Zed reads only the first rules file it finds, and `.rules`, `.cursorrules` and some other names come before `AGENTS.md`. If the project has one of these files, append the rules to that file. `ctx init` writes `.cursorrules` and `.windsurfrules` into a new vault, so a vault folder always has one.
3. Optional: add the Context Nest MCP server. Open the settings with `zed: open settings file`, then add:
   ```json
   {
     "context_servers": {
       "contextnest": {
         "command": "npx",
         "args": ["-y", "@promptowl/contextnest-mcp-server"],
         "env": {}
       }
     }
   }
   ```
   The server uses the registry default vault. To use a different vault, put its path in `args` after the package name.
4. Open the Agent Panel and start a new thread.
5. Type `/`. Expected result: the five skills show as slash commands. A global skill has an empty prefix (`/:contextnest-recall`). A project skill has the folder name as its prefix (`/<folder>:contextnest-recall`).

Skills and rules apply only to the Zed Agent. External agents in Zed (Claude Code, Codex, Gemini CLI) use their own plugin from this repository.

## What Zed reads

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

- Auto-retrieval on each prompt, the capture gate and the correction sweep. Add them if Zed adds agent hooks. The Codex adapter (`plugins/shared/hooks/codex.js`) is the model to copy.
- A Zed extension. Zed extensions are Rust compiled to WASM and cannot add skills or rules. The MCP server in step 3 needs no extension.
