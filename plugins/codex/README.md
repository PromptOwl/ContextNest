# Context Nest — Codex adapter (planned)

> Status: **scaffold only.** Not yet implemented. This README documents the intended
> design so the adapter can be built without restructuring anything.

OpenAI Codex leans on `AGENTS.md` + MCP server configuration rather than a
Claude-style hook lifecycle, so the adapter differs from the Claude Code plugin in
*wiring*, not in *behavior*.

## Plan

1. **Retrieval + capture tools** — wire the existing
   [`@promptowl/contextnest-mcp-server`](../../packages/mcp-server) into Codex's MCP
   config so its `search` / `query` / `create_document` / `update_document` tools are
   available to the model.
2. **Reuse the shared core** — for any lifecycle automation Codex supports (e.g.
   pre/post hooks), invoke the vendored `core/*.js` scripts the same way Claude does;
   they read config from the `CONTEXTNEST_*` environment fallbacks
   (`CONTEXTNEST_RETRIEVAL_MODE`, `CONTEXTNEST_AUTO_CAPTURE`, `CONTEXTNEST_VAULT_ALIAS`,
   `CONTEXTNEST_CTX_COMMAND`) since Codex has no `userConfig` mechanism.
3. **`AGENTS.md` guidance** — ship a snippet (generated via `ctx index`) telling Codex
   to query the vault before answering and to capture aggressively.

When implemented, this directory gains a vendored `core/` (via `pnpm plugins:sync`)
and the relevant Codex config files. No changes to `plugins/shared/` are expected.
