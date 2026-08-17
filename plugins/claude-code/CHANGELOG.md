# Changelog

## 0.3.0

The plugin now decides *whether* to touch the vault before deciding *what* to
write, and a correction lands everywhere rather than in the first node it finds.

- **New `capture_mode` setting: `off` | `propose` (default) | `auto`.** In
  `propose` the capture agent is read-only — it proposes in one line and waits
  for you. `auto` is the old unattended behaviour. `auto_capture` is deprecated
  but still honoured (`true`→`propose`, `false`→`off`) so existing installs keep
  working; `capture_mode` wins when both are set.
- **The `Stop` gate is far quieter.** It used to fire whenever any tool ran,
  which in a coding session is every turn. It now fires on explicit intent
  ("remember this"), on a correction, or — for an ambient pass — only once the
  session is out of a cooldown window tracked per session in
  `~/.contextnest/plugin-state/`. Short sessions are never interrupted at all.
  Tune with `CONTEXTNEST_CAPTURE_MIN_TURNS` (default 5).
- **New `contextnest-curator` agent**, invoked when you correct something. It
  sweeps for *every* node carrying the stale fact — `ctx search` is ranked and
  published-only, so it also lists drafts and reads candidates — then changes
  them together, or reports that the vault never asserted it. Structural changes
  (a concept renamed, a decision reversed, a node that should split or be
  retyped) stop and ask instead of proceeding.
- **The change ladder is injected up front** on correction-shaped prompts, not
  just at end of turn, so the sweep happens before the edit rather than after.
- **Capture is gated by a ladder that defaults to no.** A candidate must be
  statable as a headline plus one "why it matters" sentence, must not already be
  in the vault, and must not fit as one more sentence on an existing node before
  a new node is created. Time-bound facts (a price, a metric, a version) are
  captured with an as-of date and a `#time-bound` tag rather than dropped.
- The capture prompt no longer assumes a codebase: it calibrates what counts as
  durable from the target vault's own `description`, so a positioning vault and
  a security vault are judged on their own terms.
- **New `/contextnest:capture`** for capturing on purpose, including when
  `capture_mode` is `off`.

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
