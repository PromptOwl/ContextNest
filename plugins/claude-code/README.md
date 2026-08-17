# Context Nest — Claude Code plugin

Makes any Claude Code session **vault-aware** and **self-maintaining**:

- **Auto-retrieval** — a `UserPromptSubmit` hook pulls relevant vault material into
  each prompt (effort-toggled), so Claude answers from your governed knowledge base.
- **Deliberate capture** — a `Stop` hook triggers a capture agent, but only on a real
  signal (you asked, or you corrected something, or the session has run on past a
  cooldown). By default that agent *proposes* in one line and writes nothing until
  you agree.
- **Consistent corrections** — when you correct something the vault records, a curator
  agent sweeps for every node carrying the stale fact and changes them together,
  rather than fixing the first hit and leaving the rest contradicting it.
- **Session overview** — a `SessionStart` hook injects a compact list of your vaults.

Everything runs through the existing [`ctx`](../../packages/cli) CLI internally — no
MCP wiring required.

## Requirements

The Context Nest CLI must be available. Either install it globally:

```bash
npm i -g @promptowl/contextnest-cli
```

…or leave it — the plugin falls back to `npx -y @promptowl/contextnest-cli` (slower
cold start). Node ≥ 20 is required.

## Install

```text
/plugin marketplace add promptowl/contextnest      # this repo
/plugin install contextnest
```

On enable you'll be prompted for the settings below (all optional):

| Setting | Default | Meaning |
| --- | --- | --- |
| **Retrieval effort** | `search` | `off` · `search` (cheap) · `query` (graph) · `agent` (full reasoning) |
| **Capture behaviour** | `propose` | `off` (never on its own) · `propose` (propose, write once you agree) · `auto` (write unattended) |
| **Pinned vault** | _(empty)_ | A registered vault alias. Empty → the agents pick the relevant vault(s) automatically |
| **ctx binary** | `ctx` | Override the CLI command |

## Changing settings later

Claude Code only prompts for the settings above once, at enable time. To view
or change them afterwards, use the config command:

```text
/contextnest:config                          # show settings, then pick what to change
/contextnest:config retrieval_mode query     # change for this project
/contextnest:config capture_mode off --global     # change for all projects
```

Run bare `/contextnest:config` and it shows the current settings, then walks you
through a picker — choose the setting, choose the value from its valid options
(pinned vault is filled from your registered aliases), and choose the scope. No
need to remember exact values; typing a `<setting> <value>` pair still works for
scripting.

Changes are written to a settings override file and take effect on the next
prompt — no restart or re-enable needed. You can also edit the files directly
(keys: `retrieval_mode`, `capture_mode`, `vault`, `ctx_command`):

| Scope | File | Precedence |
| --- | --- | --- |
| Project | `.claude/contextnest.local.json` | highest |
| User | `~/.contextnest/plugin-settings.json` | beats enable-time values |

A key present in an override file always beats the enable-time answer; an
explicit `"vault": ""` unpins a pinned vault. Remove a key to fall back to the
enable-time value (then the default).

## How it decides to touch the vault

A knowledge base earns its keep by being small enough to trust, so both write
paths run a ladder and stop at the first rung that resolves. Most candidates
never reach the bottom, and silence is the normal outcome.

**Capturing something new.** Can it be stated as a headline plus one "why it
matters" sentence? → Will both still be true next month (if not, is it worth an
as-of date and a `#time-bound` tag)? → Is it already in the vault? → Would one
more sentence on an existing node do? → Is it really just a tag or a title? →
only then, the smallest new node.

**Correcting something.** Does the vault actually assert the old value? → Find
*every* occurrence before editing, not the first hit → one node, one sentence →
several nodes, changed together with the before-marker recorded → structural,
which stops and asks.

When the same fact turns out to live in several nodes, fixing all of them is the
patch, not the cure: it will need correcting in all of them again next time. The
curator says so and offers to make one node canonical with the rest linking to
it — offered, never done unasked, because collapsing nodes is structural.

A change is "structural" when the vault would end up contradicting itself, when
a node's title or type no longer fits its body, when the corrected term is a
concept the vault is organised around (a rename, not an edit), or when a
recorded decision has been reversed so the stated reasoning is now wrong. Those
are presented for your approval rather than applied.

The ladders are domain-free — the capture agent calibrates what counts as
durable from the target vault's own `description`, so a positioning vault and a
security vault are judged on their own terms.

## Components

| Type | Name | Role |
| --- | --- | --- |
| Hook | `SessionStart` | Inject vault overview (or a warning if `ctx` is missing) |
| Hook | `UserPromptSubmit` | Effort-toggled retrieval injection |
| Hook | `Stop` | Loop-safe gate; fires on explicit intent, a correction, or past the cooldown |
| Agent | `contextnest-retriever` | Selects vault(s), builds a selector, runs `ctx query`, returns a cited digest |
| Agent | `contextnest-capture` | Walks the capture ladder; proposes (or, in `auto`, writes) the minimum |
| Agent | `contextnest-curator` | Sweeps the vault so a correction lands in every node that carries it |
| Skill | `/contextnest:recall <topic>` | Manual deep retrieval |
| Command | `/contextnest:config` | View/change plugin settings after enable |
| Command | `/contextnest:capture` | Capture on purpose, even when `capture_mode` is `off` |

## Local development

The `core/` directory is **vendored** from [`plugins/shared/`](../shared) — do not edit
it here. Change the source and re-sync from the repo root:

```bash
pnpm plugins:sync          # regenerate vendored core + agent/skill bodies
pnpm plugins:check         # verify no drift (used in CI)
claude --plugin-dir ./plugins/claude-code --debug
```
