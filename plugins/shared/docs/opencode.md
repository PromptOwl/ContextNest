# Context Nest — OpenCode

> **Status:** **Built.** Tested end to end with OpenCode 2.0.32: rules and retrieval reach the model, a `ctx update` gets a sweep report, and "remember this" queues a capture pass for the next prompt. OpenCode 1.18.29 loads the plugin and its skills. The other OpenCode 1 hooks (`server`) are unit-tested only. `node` is not needed: the plugin runs inside OpenCode.

Makes an OpenCode session **vault-aware** (auto-retrieval on each prompt) and **self-maintaining** (governed capture and correction sweeps). It drives the [`ctx`](../../../packages/cli) CLI directly.

## Install

OpenCode 2: put this line in `~/.config/opencode/plugins/index.js`. For one project only, put it in `<project>/.opencode/plugins/index.js`.

```js
export { default } from "/absolute/path/to/ContextNest/plugins/shared/opencode/index.js";
```

`opencode plugin add` does not accept a local path in OpenCode 2.0.32. It accepts an npm or Git package only, and this plugin is not published as a package.

OpenCode 1: add the plugin directory to `opencode.json`:

```json
{ "plugin": ["/absolute/path/to/ContextNest/plugins/shared"] }
```

Start a new session after you install. In OpenCode 2, run `opencode plugin list` to see `contextnest`. Immediately after the background service starts, the list can be empty. Run the command again.

## What it does

OpenCode plugins run in-process, so there are no hook scripts. `opencode/adapter.js` feeds one per-session engine from either plugin API. The engine calls the same shared core as the Claude Code plugin.

| Engine step | OpenCode 2 (`setup`) | OpenCode 1 (`server`) | Core module |
| --- | --- | --- | --- |
| Close the last turn, then retrieve | `session.hook("prompt")` | `chat.message` | `capture-gate`, then `retrieve` |
| Overview, rules, retrieval and sweep reports into the system prompt | `session.hook("context")` and `"compaction"` | `experimental.chat.system.transform` | `session-start` (once per session) |
| Sweep after a `ctx update` | Finished `shell` calls in the context messages | `tool.execute.after` on `bash` | `sweep-check` |
| Skills | `skill.transform` | `config` → `skills.paths` | — |

The capture gate runs at the start of the next prompt, not when the turn ends. Claude Code runs `Stop` and then `UserPromptSubmit` at that same moment, so the result is the same. OpenCode 2 gives a plugin no idle event, and its tool hooks did not fire in a live test.

The hook messages name the Claude Code agents. The rules map each agent to a skill: `contextnest-recall`, `contextnest-capture`, `contextnest-curate`, `contextnest-structure`. They map `/contextnest:setup` to the `contextnest-setup` skill.

## Layout

OpenCode reads these files in `plugins/shared/`, the plugin root that all agents but Claude Code share:

```text
plugins/shared/
├── package.json             # "main" names opencode/index.js
├── opencode/index.js        # Default export: setup (OpenCode 2) + server (OpenCode 1)
├── opencode/adapter.js      # The engine and both hook sets
├── core/                    # The shared hook logic
├── rules/contextnest.md     # The operating rules
└── skills/                  # The skills
```

## Configuration

Set environment variables, or put the same keys (`retrieval_mode`, `capture_mode`, `vault`, ...) in `~/.contextnest/plugin-settings.json`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONTEXTNEST_RETRIEVAL_MODE` | `search` | `off` \| `search` \| `query` \| `agent` |
| `CONTEXTNEST_CAPTURE_MODE` | `explicit` | `off` \| `explicit` \| `propose` \| `auto` |
| `CONTEXTNEST_VAULT_ALIAS` | _(none)_ | Pinned vault alias |
| `CONTEXTNEST_UNCLEAR_NEST` | `ask` | `ask` \| `default` |
| `CONTEXTNEST_CTX_COMMAND` | `ctx` | The `ctx` binary |

## Limits

- `ctx` runs synchronously inside the OpenCode server, for at most `CONTEXTNEST_CTX_TIMEOUT_MS` per call (30 s for a sweep).
- Per-session state is kept in memory until OpenCode stops.

## Verification

```bash
pnpm test plugins/__tests__/opencode-adapter.test.ts
pnpm plugins:check
```
