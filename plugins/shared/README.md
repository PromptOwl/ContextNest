# Context Nest shared plugin

**This directory is the single source of truth, and it is the plugin itself for six agents.** Codex, Gemini/Antigravity, OpenCode, Grok Build, Muse Code and Zed read it in place. Each one has a manifest, a hook map or an install step that points at the same `core/`, `skills/` and `rules/`, so no agent has a copy.

Claude Code is the exception. It keeps `plugins/claude-code/`, and `pnpm plugins:sync` vendors `core/` and the prompt bodies into it. Edit here, then run the sync from the repo root.

## What each agent reads

| Agent | Entry point | Then uses | Install steps |
| --- | --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` | `hooks/codex-hooks.json` → `hooks/codex.js`, `core/`, `skills/`, `rules/` | [docs/codex.md](docs/codex.md) |
| Gemini CLI & Antigravity | `plugin.json`, `hooks.json` | `hooks/antigravity.js`, `core/`, `skills/`, `rules/` | [docs/gemini.md](docs/gemini.md) |
| OpenCode | `package.json` (`main`) | `opencode/index.js`, `opencode/adapter.js`, `core/`, `skills/`, `rules/` | [docs/opencode.md](docs/opencode.md) |
| Grok Build | `skills/plugin.json` | `skills/`; the user copies `rules/contextnest.md` into `AGENTS.md` | [docs/grok.md](docs/grok.md) |
| Muse Code | `muse skills install` | `skills/`; the user copies `rules/contextnest.md` into `AGENTS.md` | [docs/muse.md](docs/muse.md) |
| Zed | The user copies the folders | `skills/`; the user copies `rules/contextnest.md` into `AGENTS.md` | [docs/zed.md](docs/zed.md) |

Rules for this directory:

- **Do not add a directory or a copy for an agent.** Add its manifest or adapter here, and point it at the files that exist.
- **Do not add `hooks/hooks.json`.** Claude Code, Grok Build and Gemini CLI load that path without being told to. Name a hook map after its agent, and name it in that agent's manifest.
- **Keep adapters out of `core/`.** The sync copies all of `core/` into the Claude Code plugin.

## Contents

| Path | What it is |
| --- | --- |
| `core/lib.js` | Config from env, the `ctx` runner (with `npx` fallback), vault selection, JSON helpers, the hook IO shell. |
| `core/retrieve.js` | `UserPromptSubmit` handler — effort-toggled retrieval, and the single place a parked job is dispatched. |
| `core/session-start.js` | `SessionStart` handler — injects a compact vault overview, or a warning if `ctx` is missing. |
| `core/capture-gate.js` | `Stop` handler — decides whether to touch the vault and parks the job; never blocks the turn. |
| `core/signals.js` | Pure transcript classifiers: the last real user message, explicit capture intent, correction intent. |
| `core/ledger.js` | Per-session state under `~/.contextnest/plugin-state/` — the ambient-capture cooldown and the parked job queue. |
| `core/sweep-check.js` | `PostToolUse` handler — after a `ctx update`, finds nodes in any nest still carrying the removed value. |
| `prompts/retriever.md` | Body of the retriever agent (digest mode + scout mode for writes). |
| `prompts/capture.md` | Body of the capture agent (the capture ladder). |
| `prompts/curate.md` | Body of the curator agent (the change and escalation ladders). |
| `prompts/recall.md` | Body of the Claude Code manual recall skill. |
| `prompts/structure.md` | Body of the structure skill. |
| `rules/contextnest.md` | The operating rules, with the agent → skill map. Antigravity loads the file, the Codex and OpenCode adapters inject it, and Grok, Muse and Zed users copy it into `AGENTS.md`. |
| `skills/<name>/SKILL.md` | The skills every agent reads. The sync fills the bodies of `contextnest-recall`, `-capture`, `-curate` and `-structure` from `prompts/`; `contextnest-setup` is written by hand. |
| `hooks/codex.js`, `hooks/antigravity.js` | Adapters from each agent's hook contract to `core/`. |
| `opencode/` | The OpenCode in-process plugin: one engine for the OpenCode 1 and 2 APIs. |
| `docs/` | Install steps for each agent. |

## Design contract

- **Pure + testable.** Each `core/*.js` module exports `run({ input, env, exec })` (a pure function returning the hook output object, or `null` to do nothing) plus a thin IO shell guarded by `isMain(import.meta.url)`. Unit tests call `run()` with a fake `exec`; no subprocess required. `capture-gate.js` takes injected transcript and ledger readers for the same reason, so its decision is tested without a filesystem.
- **Decisions live in code, judgement lives in prompts.** *Whether* to engage the vault is a pure function here; *what* to write is the agent's call, guided by the ladders in `prompts/`. Keeping the gate out of the prompt is what makes the quiet behaviour testable.
- **Agent-agnostic.** Nothing imports a Claude API. Config is read from `CLAUDE_PLUGIN_OPTION_*` with `CONTEXTNEST_*` fallbacks, so other agents can feed the same values without Claude's `userConfig` mechanism.
- **Zero runtime deps.** Plain Node ≥ 20 ESM, no `jq`, cross-platform.

## Config (environment)

| Setting | Claude userConfig env | Generic fallback | Default |
| --- | --- | --- | --- |
| Retrieval mode | `CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE` | `CONTEXTNEST_RETRIEVAL_MODE` | `search` |
| Capture mode | `CLAUDE_PLUGIN_OPTION_CAPTURE_MODE` | `CONTEXTNEST_CAPTURE_MODE` | `propose` |
| Auto-capture *(deprecated)* | `CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE` | `CONTEXTNEST_AUTO_CAPTURE` | `true` → `propose` |
| Pinned vault | `CLAUDE_PLUGIN_OPTION_VAULT` | `CONTEXTNEST_VAULT_ALIAS` | _(none → agent decides)_ |
| ctx binary | `CLAUDE_PLUGIN_OPTION_CTX_COMMAND` | `CONTEXTNEST_CTX_COMMAND` | `ctx` |

`capture_mode` is `off` | `propose` | `auto`. It supersedes the `auto_capture` boolean, which is still read for existing installs (`true` → `propose`, `false` → `off`); an explicit mode wins wherever it is set.

`CONTEXTNEST_CAPTURE_MIN_TURNS` (default `5`) is how many user turns must pass before an *ambient* capture pass may fire again — the clock starts at session start, so a short session is never interrupted by one. Explicit intent ("remember this") and corrections bypass it entirely. `CONTEXTNEST_CAPTURE_ALWAYS=1` bypasses both the heuristic and the cooldown.
