---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

Human review gate, on by default for new vaults. `ctx init` writes `review: on` to `.context/config.yaml`; with it on, `ctx add` / `ctx update` and MCP `context_create` / `context_update` hold the write for approval instead of publishing it — a new document lands as `pending_review`, an edit to a published document is staged under `_suggestions/` while the published version keeps serving, and nothing is versioned or checkpointed until approved. At a terminal the CLI asks `Held for review. Publish? [y]es / [n]o / [a]lways (turn review off)`; without one it never blocks and prints `Held for review: ctx review approve <path>   (turn off: ctx config set review off)`. MCP results carry `held_for_review` and a sentence telling the agent the user can say "turn off review". New: `ctx review [list|approve|reject]`, `ctx config get|set review`, `--publish` on add/update, the `context_review` MCP tool, and a `review` input on the `context_create` / `context_update` catalog ops. Vaults without the key (created before this release) keep publishing immediately.

The deprecated MCP `create_document` / `update_document` tools are gated the same way. `ctx review approve|reject` act only on held writes (`pending_review` nodes or held edits), never on plain drafts; `ctx config` / `ctx review` refuse a remote `<server>/<nest>` alias. The Claude Code plugin knows about held writes: the capture and curator agents report them for the user to approve instead of claiming a publish, and the sweep-check hook skips a held `ctx update` rather than diffing an older, unrelated edit.
