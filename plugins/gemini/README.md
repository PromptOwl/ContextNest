# Context Nest — Gemini CLI adapter (planned)

> Status: **scaffold only.** Not yet implemented. This README documents the intended
> design so the adapter can be built without restructuring anything.

Gemini CLI extensions support context files, MCP servers, and custom commands. The
adapter reuses Context Nest's existing pieces with a thin Gemini wrapper.

## Plan

1. **`gemini-extension.json`** — register the existing
   [`@promptowl/contextnest-mcp-server`](../../packages/mcp-server) so the vault's
   read/mutation tools are available, and point Gemini at a generated `GEMINI.md`
   (produced by `ctx index`) for query-before-answering guidance.
2. **Custom commands** — expose `recall` and `capture` as Gemini commands whose
   handlers call the vendored `core/*.js` scripts (configured via the `CONTEXTNEST_*`
   environment fallbacks), giving Gemini the same effort-toggled retrieval and capture
   behavior as the Claude Code plugin.
3. **Vendored core** — `pnpm plugins:sync` will populate this directory's `core/` from
   `plugins/shared/`, identical to the Claude Code plugin.

No changes to `plugins/shared/` are expected — the core is already agent-agnostic.
