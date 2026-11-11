# Context Nest — Zed plugin

> **Status:** **Built, instruction tier.** Rules and skills only, no lifecycle hooks. The Zed Agent has no hook API, so the shared hook core is not wired in.

Gives the [Zed Agent](https://zed.dev/docs/ai/agent-panel) the Context Nest operating rules and the four portable skills. The agent drives the [`ctx`](../../packages/cli) CLI directly.

## Install

1. Install the skills for your user. Zed reads [skills](https://zed.dev/docs/ai/skills) from `~/.agents/skills/`, one folder for each skill:
   ```bash
   mkdir -p ~/.agents/skills && cp -R plugins/zed/skills/* ~/.agents/skills/
   ```
   For one project only, copy the folders into `<project>/.agents/skills/`. Zed loads project skills and `.zed/settings.json` only from a trusted worktree. A new folder opens in Restricted Mode: click the exclamation mark icon in the title bar, or run `workspace: toggle worktree security`, then trust it.
2. Add the rules. Copy `plugins/zed/AGENTS.md` into the project `AGENTS.md`, or into `~/.config/zed/AGENTS.md` for all projects. Zed reads only the first rules file it finds, and `.rules`, `.cursorrules` and some other names come before `AGENTS.md`. If the project has one of these files, append the rules to that file. `ctx init` writes `.cursorrules` and `.windsurfrules` into a new vault, so a vault folder always has one.
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
5. Type `/`. Expected result: the four skills show as slash commands. A global skill has an empty prefix (`/:contextnest-recall`). A project skill has the folder name as its prefix (`/<folder>:contextnest-recall`).

Skills and rules apply only to the Zed Agent. External agents in Zed (Claude Code, Codex, Gemini CLI) use their own plugin from this repository.

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

- Auto-retrieval on each prompt, the capture gate and the correction sweep. Add them if Zed adds agent hooks. The Codex adapter (`plugins/codex/hooks/codex.js`) is the model to copy.
- A Zed extension. Zed extensions are Rust compiled to WASM and cannot add skills or rules. The MCP server in step 3 needs no extension.
