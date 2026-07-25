# Changelog

## 0.2.0

Settings are no longer frozen at enable time (CU-wdqcpzw825).

- New `/contextnest:config` command to view and change `retrieval_mode`,
  `auto_capture`, `vault`, and `ctx_command` at any time. Bare invocation
  drives the change through interactive pickers (setting, value, scope) instead
  of requiring the user to type an exact value; the pinned-vault choices are
  populated from the registered vault aliases. A `<setting> <value>` pair still
  works for scripting.
- Settings override files, read by every hook and beating the enable-time
  values: project `.claude/contextnest.local.json` > user
  `~/.contextnest/plugin-settings.json` > `CLAUDE_PLUGIN_OPTION_*` >
  `CONTEXTNEST_*` > defaults. An explicit `"vault": ""` unpins.
- Missing/malformed override files are ignored — hooks never break a session.

## 0.1.0

Initial release.

- `SessionStart` hook injecting a vault overview (graceful warning when `ctx` is absent).
- Effort-toggled `UserPromptSubmit` retrieval: `off` / `search` / `query` / `agent`.
- Loop-safe `Stop` hook that triggers the `contextnest-capture` agent on substantive turns.
- `contextnest-retriever` and `contextnest-capture` agents driving the `ctx` CLI.
- `/contextnest:recall` skill for manual deep retrieval.
- Vault selection: pinned alias via config, otherwise agent-decided from the registry.
