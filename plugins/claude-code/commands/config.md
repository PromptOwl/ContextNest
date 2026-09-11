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
| `capture_mode` | `off` \| `propose` \| `auto` | What happens when something looks worth keeping |
| `auto_capture` | `true` \| `false` | **Deprecated** — superseded by `capture_mode` (`true`→`propose`, `false`→`off`) |
| `vault` | registered vault alias, or `""` to unpin | Pinned vault |
| `ctx_command` | any command string | Override the `ctx` binary |

Override files (higher wins; both beat enable-time values):

1. Project: `.claude/contextnest.local.json` (in the project root)
2. User: `~/.contextnest/plugin-settings.json`

## What to do

Arguments given: `$ARGUMENTS`

Prefer interactive pickers over asking the user to type. Only `ctx_command`
takes a free-text value; every other setting has a fixed or enumerable list of
choices, so present those as a selectable menu (the `AskUserQuestion` tool)
rather than making the user remember and type an exact string.

### Step 1 — always show current effective settings first

Read both override files (if present) and the
`CLAUDE_PLUGIN_OPTION_RETRIEVAL_MODE`, `CLAUDE_PLUGIN_OPTION_CAPTURE_MODE`,
`CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE`, `CLAUDE_PLUGIN_OPTION_VAULT`,
`CLAUDE_PLUGIN_OPTION_CTX_COMMAND` environment variables, then present a small
table: each setting, its effective value, and which layer it came from (project
file / user file / enable-time / default).

When `capture_mode` is unset anywhere, show the value the legacy `auto_capture`
maps to (`true`→`propose`, `false`→`off`, absent→`propose`) and label the layer
as "auto_capture (deprecated)", so the effective behaviour is never a mystery.

### Step 2 — decide how the change is specified

**If a valid `<setting> <value>` pair was given as arguments** — skip the
pickers and go straight to *Apply the change* below. This keeps the command
scriptable.

**Otherwise (no arguments, or a setting named without a valid value)** — drive
the change interactively with `AskUserQuestion`:

1. **Which setting** — if the user didn't already name one, ask which setting
   to change with one question whose options are `retrieval_mode`,
   `capture_mode`, `vault`, `ctx_command` (label each with its current value).
   Don't offer `auto_capture` in the picker — it's deprecated; steer anyone who
   names it to `capture_mode` instead.
2. **Which value** — ask a follow-up whose options are that setting's choices:
   - `retrieval_mode` → `off`, `search`, `query`, `agent` (describe each:
     off = no injection, search = cheap full-text, query = graph, agent = full
     reasoning).
   - `capture_mode` → `off` (never writes on its own; use
     `/contextnest:capture`), `propose` (reviews the turn and proposes in one
     line, writes only once you agree), `auto` (writes unattended, still behind
     the capture ladder and the cooldown).
   - `vault` → enumerate the registered vault aliases by running
     `<ctx_command> vault list --json` (fall back to `ctx vault list --json`);
     offer each alias as an option (label it with its description), plus an
     **Unpin (auto-select)** option that maps to the empty string `""`. Never
     make the user type an alias.
   - `ctx_command` → this one is free-form; ask the user to type the command
     (the picker doesn't apply). The "Other" free-text answer on any question
     also lets a user supply a value not in the list.
3. **Which scope** — if `--global` was not passed as an argument, ask whether
   this applies to **This project only** (`.claude/contextnest.local.json`) or
   **All projects** (`~/.contextnest/plugin-settings.json`).

### Step 3 — apply the change

1. Validate — the key must be one of the four, and its value must pass:
   - `retrieval_mode` → one of `off|search|query|agent` (case-insensitive).
   - `capture_mode` → one of `off|propose|auto` (case-insensitive).
   - `auto_capture` → a boolean spelling: `true|1|yes|on` or `false|0|no|off`.
     Still accepted for existing installs, but when someone sets it, write
     `capture_mode` instead (`true`→`propose`, `false`→`off`) and tell them why.
   - `vault` → either the empty string `""` (unpin) or a registered alias.
     Check membership by running `<ctx_command> vault list --json` (fall back
     to `ctx vault list --json`); reject an alias that isn't registered and
     show the available aliases. The alias shape is `[A-Za-z0-9_-]+`.
   - `ctx_command` → a non-empty string.

   On invalid input, say what's wrong and stop — do not write anything.
   (Picker-sourced values are already valid; still validate free-text/`Other`
   answers.)
2. Target file: `.claude/contextnest.local.json` in the project root for
   project scope, or `~/.contextnest/plugin-settings.json` for global scope
   (`--global` or the "All projects" choice).
3. Read the existing file if present, merge the new key (preserve other keys),
   and write it back as pretty-printed JSON. Create the parent directory if
   needed. For **Unpin**, write `"vault": ""` explicitly — the empty string is
   honoured as a deliberate unpin.
4. For project scope, make sure `.claude/contextnest.local.json` is ignored by
   git — it is a personal, per-checkout override and must not be committed.
   If the project is a git repo and the path isn't already ignored (check with
   `git check-ignore -q .claude/contextnest.local.json`), append it to the
   repo's `.gitignore`.
5. Confirm to the user: the new value, the file written, and that it takes
   effect from the next prompt in any session — no restart or re-enable
   needed. To undo, remove the key from that file.
