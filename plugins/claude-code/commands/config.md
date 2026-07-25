---
description: View or change Context Nest plugin settings (retrieval effort, auto-capture, pinned vault, ctx binary) without re-enabling the plugin.
argument-hint: "[<setting> <value>] [--global]"
---

# Context Nest plugin settings

Claude Code only prompts for this plugin's settings once, when it is enabled.
This command lets the user view and change them at any time by writing a
settings override file that the plugin's hooks read on every invocation
(overrides beat the frozen enable-time values).

Settings and valid values:

| Key | Values | Meaning |
|-----|--------|---------|
| `retrieval_mode` | `off` \| `search` \| `query` \| `agent` | Retrieval effort per prompt |
| `auto_capture` | `true` \| `false` | Persist new knowledge at end of turn |
| `vault` | registered vault alias, or `""` to unpin | Pinned vault |
| `ctx_command` | any command string | Override the `ctx` binary |

Override files (higher wins; both beat enable-time values):

1. Project: `.claude/contextnest.local.json` (in the project root)
2. User: `~/.contextnest/plugin-settings.json`

## What to do

Arguments given: `$ARGUMENTS`

**If no arguments were given** — show current effective settings. Read both
override files (if present) and the `CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE`,
`CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE`, `CLAUDE_PLUGIN_OPTION_VAULT`,
`CLAUDE_PLUGIN_OPTION_CTX_COMMAND` environment variables, then present a
small table: each setting, its effective value, and which layer it came from
(project file / user file / enable-time / default). Mention how to change one:
`/contextnest:config <setting> <value>`.

**If a setting and value were given** — apply the change:

1. Validate: the key must be one of the four above; `retrieval_mode` must be
   one of `off|search|query|agent`; `auto_capture` must parse as a boolean.
   On invalid input, say what's wrong and stop — do not write anything.
2. Pick the target file: `.claude/contextnest.local.json` in the project root
   by default, or `~/.contextnest/plugin-settings.json` when `--global` was
   passed.
3. Read the existing file if present, merge the new key (preserve other keys),
   and write it back as pretty-printed JSON. Create the parent directory if
   needed.
4. Confirm to the user: the new value, the file written, and that it takes
   effect from the next prompt in any session — no restart or re-enable
   needed. To undo, remove the key from that file.
