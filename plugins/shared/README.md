# Context Nest plugin core (shared)

Agent-agnostic building blocks shared by every Context Nest coding-agent plugin
(Claude Code today; Codex / Gemini later). **This is the single source of truth.**
Edit here, then run `pnpm plugins:sync` from the repo root to vendor the result
into each agent plugin.

## Contents

| Path | What it is |
| --- | --- |
| `core/lib.js` | Config from env, the `ctx` runner (with `npx` fallback), vault selection, JSON helpers, the hook IO shell. |
| `core/retrieve.js` | `UserPromptSubmit` handler — effort-toggled retrieval (`off` / `search` / `query` / `agent`). |
| `core/session-start.js` | `SessionStart` handler — injects a compact vault overview, or a warning if `ctx` is missing. |
| `core/capture-gate.js` | `Stop` handler — loop-safe gate that triggers the capture agent on substantive turns. |
| `prompts/retriever.md` | Body of the retriever agent. |
| `prompts/capture.md` | Body of the capture agent. |
| `prompts/recall.md` | Body of the manual recall skill. |

## Design contract

- **Pure + testable.** Each `core/*.js` module exports `run({ input, env, exec })`
  (a pure function returning the hook output object, or `null` to do nothing) plus
  a thin IO shell guarded by `isMain(import.meta.url)`. Unit tests call `run()`
  with a fake `exec`; no subprocess required.
- **Agent-agnostic.** Nothing imports a Claude API. Config is read from
  `CLAUDE_PLUGIN_OPTION_*` with `CONTEXTNEST_*` fallbacks, so other agents can feed
  the same values without Claude's `userConfig` mechanism.
- **Zero runtime deps.** Plain Node ≥ 20 ESM, no `jq`, cross-platform.

## Config (environment)

| Setting | Claude userConfig env | Generic fallback | Default |
| --- | --- | --- | --- |
| Retrieval mode | `CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE` | `CONTEXTNEST_RETRIEVAL_MODE` | `search` |
| Auto-capture | `CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE` | `CONTEXTNEST_AUTO_CAPTURE` | `true` |
| Pinned vault | `CLAUDE_PLUGIN_OPTION_VAULT` | `CONTEXTNEST_VAULT_ALIAS` | _(none → agent decides)_ |
| ctx binary | `CLAUDE_PLUGIN_OPTION_CTX_COMMAND` | `CONTEXTNEST_CTX_COMMAND` | `ctx` |

`CONTEXTNEST_CAPTURE_ALWAYS=1` forces capture on every turn (skips the
substantive-turn heuristic).
