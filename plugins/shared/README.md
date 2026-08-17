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
| `core/capture-gate.js` | `Stop` handler — loop-safe gate deciding whether to touch the vault, and as a capture or a correction. |
| `core/signals.js` | Pure transcript classifiers: the last real user message, explicit capture intent, correction intent. |
| `core/ledger.js` | Per-session capture state under `~/.contextnest/plugin-state/` — the cooldown that keeps ambient captures rare. |
| `prompts/retriever.md` | Body of the retriever agent. |
| `prompts/capture.md` | Body of the capture agent (the capture ladder). |
| `prompts/curate.md` | Body of the curator agent (the change and escalation ladders). |
| `prompts/recall.md` | Body of the manual recall skill. |

## Design contract

- **Pure + testable.** Each `core/*.js` module exports `run({ input, env, exec })`
  (a pure function returning the hook output object, or `null` to do nothing) plus
  a thin IO shell guarded by `isMain(import.meta.url)`. Unit tests call `run()`
  with a fake `exec`; no subprocess required. `capture-gate.js` takes injected
  transcript and ledger readers for the same reason, so its decision is tested
  without a filesystem.
- **Decisions live in code, judgement lives in prompts.** *Whether* to engage the
  vault is a pure function here; *what* to write is the agent's call, guided by
  the ladders in `prompts/`. Keeping the gate out of the prompt is what makes
  the quiet behaviour testable.
- **Agent-agnostic.** Nothing imports a Claude API. Config is read from
  `CLAUDE_PLUGIN_OPTION_*` with `CONTEXTNEST_*` fallbacks, so other agents can feed
  the same values without Claude's `userConfig` mechanism.
- **Zero runtime deps.** Plain Node ≥ 20 ESM, no `jq`, cross-platform.

## Config (environment)

| Setting | Claude userConfig env | Generic fallback | Default |
| --- | --- | --- | --- |
| Retrieval mode | `CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE` | `CONTEXTNEST_RETRIEVAL_MODE` | `search` |
| Capture mode | `CLAUDE_PLUGIN_OPTION_CAPTURE_MODE` | `CONTEXTNEST_CAPTURE_MODE` | `propose` |
| Auto-capture *(deprecated)* | `CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE` | `CONTEXTNEST_AUTO_CAPTURE` | `true` → `propose` |
| Pinned vault | `CLAUDE_PLUGIN_OPTION_VAULT` | `CONTEXTNEST_VAULT_ALIAS` | _(none → agent decides)_ |
| ctx binary | `CLAUDE_PLUGIN_OPTION_CTX_COMMAND` | `CONTEXTNEST_CTX_COMMAND` | `ctx` |

`capture_mode` is `off` | `propose` | `auto`. It supersedes the `auto_capture`
boolean, which is still read for existing installs (`true` → `propose`,
`false` → `off`); an explicit mode wins wherever it is set.

`CONTEXTNEST_CAPTURE_MIN_TURNS` (default `5`) is how many user turns must pass
before an *ambient* capture pass may fire again — the clock starts at session
start, so a short session is never interrupted by one. Explicit intent
("remember this") and corrections bypass it entirely.
`CONTEXTNEST_CAPTURE_ALWAYS=1` bypasses both the heuristic and the cooldown.
