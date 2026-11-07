# Prompts, skills and plugins over MCP

What an MCP server can put in front of a user's agent, and what Context Nest does with it. Researched November 2026 against the MCP spec repository (revision 2026-07-28), its SEPs, the TypeScript SDK and each client's docs.

## What a server can push

| Mechanism | Spec status | Clients that use it | Added automatically? |
|---|---|---|---|
| **Prompts** (`prompts/list`, `prompts/get`, arguments) | Core | Claude Code (`/server:prompt`), Claude Desktop and claude.ai (**+** menu), VS Code (`/server.prompt`), Gemini CLI, Cursor, Goose, Zed. **Not** Codex or ChatGPT | Yes, while connected. The user starts them |
| **Server `instructions`** | Core | Claude Code (first 4,096 characters), VS Code, Gemini CLI, Codex, Goose | Added to the model's context. The spec doesn't guarantee it |
| **Resources** | Core | Claude Code (`@server:uri`), Desktop and claude.ai, VS Code, Gemini CLI, Cursor | Offered; the user or host attaches them |
| **Skills** (SEP-2640, extension `io.modelcontextprotocol/skills`) | Final since 2026-09-13; the extension is Beta | MCPJam, mcpc, Glean; ChatGPT (snapshot at plugin submission). Not yet in Claude Code, Claude Desktop, VS Code or Cursor | No. The spec has no install step: hosts fetch skill files when needed, tag them with the server they came from, and need the user's approval before a served skill can widen tool access or run code |
| **Plugins** | Not part of MCP | — | No client lets a server install a plugin. It works the other way round: a plugin bundles MCP servers |

So a server reliably delivers prompts and instructions. Skills over MCP are standardized but few clients load them yet. Plugins travel through each client's own channel:

- **Claude Code:** plugin marketplaces. This repo ships `.claude-plugin/marketplace.json`. A team rolls the plugin out with `extraKnownMarketplaces` and `enabledPlugins` in a repo's `.claude/settings.json` or in managed settings.
- **claude.ai:** an organization Owner can mark a plugin Required.
- **Cursor:** a `cursor://anysphere.cursor-deeplink/mcp/install?…` link.
- **VS Code:** a `vscode:mcp/install?…` link, or `code --add-mcp`.
- **Gemini CLI:** `gemini extensions install <repo>`.

## What Context Nest does

- **Prompts:** the MCP server and `ctx mcp` serve the plugin's `recall` and `capture` prompts. The text lives in `plugins/shared/prompts`, behind a preamble that maps each `ctx` step to its MCP tool. See `packages/mcp-server/README.md` for how each client starts them.
- **Instructions:** both send short server instructions: start with `context_init`, and the selector grammar.
- **Hosted nests:** `ctx --vault <server>/<nest> mcp` serves a hosted nest over stdio, signed in with the `ctx login` key.
- **Claude Code plugin:** its **Connection** setting (`cli` / `mcp-local` / `mcp-community`) decides whether the plugin also starts one of these servers. Claude Code can't switch a plugin's MCP server from a setting, so `.mcp.json` declares a single launcher that reads it.

## Not done yet

- Vault `skill` nodes and packs as prompts.
- SEP-2640 skills: serve `skill` nodes through `skills/list`, `skills/get` and `skill://` resources once Claude Code or VS Code load them.
- A `contextnest://` resource template, so a user can attach a node with `@`.
- The Community server binding `api/prompts.ts` itself, rather than only through `ctx mcp`.
