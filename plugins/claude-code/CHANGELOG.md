# Changelog

## 0.1.0

Initial release.

- `SessionStart` hook injecting a vault overview (graceful warning when `ctx` is absent).
- Effort-toggled `UserPromptSubmit` retrieval: `off` / `search` / `query` / `agent`.
- Loop-safe `Stop` hook that triggers the `contextnest-capture` agent on substantive turns.
- `contextnest-retriever` and `contextnest-capture` agents driving the `ctx` CLI.
- `/contextnest:recall` skill for manual deep retrieval.
- Vault selection: pinned alias via config, otherwise agent-decided from the registry.
