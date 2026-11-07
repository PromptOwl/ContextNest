---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

MCP clients now get the coding-agent plugin's `recall` and `capture` prompts and short server instructions.

- **Engine:** `@promptowl/contextnest-engine/api` exports `NEST_PROMPTS`, `renderNestPrompt` and `MCP_SERVER_INSTRUCTIONS`. The prompt text is the plugin's own (`plugins/shared/prompts`), copied in by `pnpm plugins:sync`, behind a preamble that maps each `ctx` command to its MCP tool.
- **MCP server:** serves both prompts (slash commands in Claude Code, VS Code and Gemini CLI; the "+" menu in Claude Desktop) and sends the instructions on connect.
- **CLI:** new `ctx --vault <server>/<nest> mcp` serves a hosted nest as a local stdio MCP server, signed in with the key `ctx login` saved. It offers the core catalog tools, run on the remote, plus the same prompts. A local vault is refused: use `contextnest-mcp-server` for that.
