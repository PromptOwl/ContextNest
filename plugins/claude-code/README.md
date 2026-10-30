# Context Nest — Claude Code plugin

Makes any Claude Code session **vault-aware** and **self-maintaining**:

- **Auto-retrieval** — a `UserPromptSubmit` hook pulls relevant vault material into each prompt (effort-toggled), so Claude answers from your governed knowledge base.
- **Deliberate capture** — a `Stop` hook queues a capture agent, but only on a real signal (you asked, or you corrected something, or the session has run on past a cooldown). By default (`explicit`) only your own asks and corrections queue it — the ambient review, a background agent run of roughly 25k tokens, is opt-in via `propose`, where the agent *proposes* in one line and writes nothing until you agree.
- **Never in your way** — the `Stop` hook never blocks the end of a turn. It parks the job and notes it in the transcript; your next message dispatches it to a background agent that works alongside whatever you asked for next.
- **Consistent corrections** — when you change something the nests record, the retriever scouts an occurrence map across every candidate nest and curator agents fan out in parallel over it — as many as the work needs — so the change lands everywhere, not in the first search hit. A `PostToolUse` sweep-check backstops it mechanically: after any `ctx update` it diffs the node against its previous version and reports every node, in every nest, still carrying the removed value. That check keys on the *write*, so it works no matter how the request was phrased. Nodes carry **entity tags** for the concrete values they assert, so the sweep also does exact tag-index lookups — catching nodes that paraphrase a fact, which no text search can.
- **Session overview** — a `SessionStart` hook injects a compact list of your vaults.

Everything runs through the existing [`ctx`](../../packages/cli) CLI internally — no MCP wiring required.

## Setup

Until you set it up, each new session starts with a reminder. Run:

```text
/contextnest:setup
```

It asks one question: **where should Claude keep its notes?**
- **On this computer** (recommended): a private folder, `~/ContextNest/main`, pre-filled for a software project.
- **Online** at nest.promptowl.ai, or your company's server: notes your team can share.
- **Both**.
- **Not now**: the reminder stops.

It then writes your first real note with you. Re-running it never replaces an existing setup.

Typing `ctx` in a terminal runs the same setup, with the same question and the same folder, so it doesn't matter which one you start with. By default Claude checks your notes on each prompt and saves only when you ask or correct something. Change that with `/contextnest:config`.

Nothing leaves your computer unless you choose to put your notes online.

## Requirements

Node ≥ 20. The hooks run on it, and on a machine without Node they fail on every event, so use the nest's MCP server on its own there.

The Context Nest CLI comes with the plugin: Claude Code installs it along with the plugin, and Claude can run `ctx` straight away. If you also want `ctx` in your own terminal, install it globally:

```bash
npm i -g @promptowl/contextnest-cli
```

Your own install takes precedence over the bundled copy. If it is older than the version this plugin ships, a new session tells you how to update it.

## Install

```text
/plugin marketplace add promptowl/contextnest      # this repo
/plugin install contextnest
```

On enable you'll be prompted for the settings below (all optional):

| Setting | Default | Meaning |
| --- | --- | --- |
| **Retrieval effort** | `search` | `off` · `search` (cheap) · `query` (graph) · `agent` (full reasoning) |
| **Capture behaviour** | `explicit` | `off` (never on its own) · `explicit` (only when you ask or correct something; proposes, writes once you agree) · `propose` (also reviews turns, writes once you agree) · `auto` (write unattended) |
| **When the nest for a new note is unclear** | `ask` | `ask` (capture asks which nest) · `default` (write to the pinned vault, else the registry default) |
| **Pinned vault** | _(empty)_ | A registered vault alias, or `<server>/<nest>`. Empty → the agents pick the relevant vault(s) automatically |
| **ctx binary** | `ctx` | Override the CLI command |

## One server, many nests

Register a Community server's all-nests endpoint once:

```text
ctx vault add contextnest --url https://<server>/mcp --bearer-env CONTEXTNEST_API_KEY
```

`ctx vault list` then shows a `contextnest/<nest>` row for every nest your key can reach, with each nest's description. Nests shared with you later appear on their own. The plugin searches `contextnest` (every nest, in one call) and cites each hit as `contextnest/<nest>:<id>`. Edits go back to that nest, and a new note goes to the nest whose description fits. When none clearly fits, the **unclear nest** setting decides: ask you (default), or use the default vault.

## Changing settings later

Claude Code only prompts for the settings above once, at enable time. To view or change them afterwards, use the config command:

```text
/contextnest:config                          # show settings, then pick what to change
/contextnest:config retrieval_mode query     # change for this project
/contextnest:config capture_mode off --global     # change for all projects
```

Run bare `/contextnest:config` and it shows the current settings, then walks you through a picker — choose the setting, choose the value from its valid options (pinned vault is filled from your registered aliases), and choose the scope. No need to remember exact values; typing a `<setting> <value>` pair still works for scripting.

Changes are written to a settings override file and take effect on the next prompt — no restart or re-enable needed. You can also edit the files directly (keys: `retrieval_mode`, `capture_mode`, `unclear_nest`, `vault`, `ctx_command`):

| Scope | File | Precedence |
| --- | --- | --- |
| Project | `.claude/contextnest.local.json` | highest |
| User | `~/.contextnest/plugin-settings.json` | beats enable-time values |

A key present in an override file always beats the enable-time answer; an explicit `"vault": ""` unpins a pinned vault. Remove a key to fall back to the enable-time value (then the default).

## How the work is scheduled

Nothing the plugin does holds up the end of a turn. The `Stop` hook decides whether the vault should be touched, writes that decision to `~/.contextnest/plugin-state/<session>.json`, and prints a one-line note. Your next prompt picks the job up and hands it to a `background: true` subagent, which runs concurrently with your new request.

The cost of that: a parked job runs when you send your next message. Walk away mid-session and the capture does not happen — use `/contextnest:capture` when you want something saved right now.

## How it decides to touch the vault

A knowledge base earns its keep by being small enough to trust, so both write paths run a ladder and stop at the first rung that resolves. Most candidates never reach the bottom, and silence is the normal outcome.

**Capturing something new.** Can it be stated as a headline plus one "why it matters" sentence? → Will both still be true next month (if not, is it worth an as-of date and a `#time-bound` tag)? → Is it already in the vault? → Would one more sentence on an existing node do? → Is it really just a tag or a title? → only then, the smallest new node.

**Correcting something.** Does the vault actually assert the old value? → Find *every* occurrence before editing, not the first hit → one node, one sentence → several nodes, changed together with the before-marker recorded → structural, which stops and asks.

When the same fact turns out to live in several nodes, fixing all of them is the patch, not the cure: it will need correcting in all of them again next time. The curator says so and offers to make one node canonical with the rest linking to it — offered, never done unasked, because collapsing nodes is structural.

A change is "structural" when the vault would end up contradicting itself, when a node's title or type no longer fits its body, when the corrected term is a concept the vault is organised around (a rename, not an edit), or when a recorded decision has been reversed so the stated reasoning is now wrong. Those are presented for your approval rather than applied.

The ladders are domain-free — the capture agent calibrates what counts as durable from the target vault's own `description`, so a positioning vault and a security vault are judged on their own terms.

## Components

| Type | Name | Role |
| --- | --- | --- |
| Hook | `SessionStart` | Inject vault overview; on a new session, tell you to run setup if nothing is set up, or to update an outdated `ctx` |
| Hook | `UserPromptSubmit` | Effort-toggled retrieval injection, and dispatches any parked job |
| Hook | `Stop` | Decides and parks; never blocks. Fires on explicit intent, a correction, or past the cooldown |
| Hook | `PostToolUse` (Bash, async) | After a `ctx update`: diffs against the prior version and names every node, in every nest, still carrying the removed value. Runs in the background — the turn is not held while it searches; its findings reach Claude on the next turn |
| Agent | `contextnest-retriever` | Digest mode for questions; scout mode returns an occurrence map for writes |
| Agent | `contextnest-capture` | Walks the capture ladder; proposes (or, in `auto`, writes) the minimum |
| Agent | `contextnest-curator` | Fixes its assigned scope (nest, or node slice) exhaustively; fanned out in parallel |
| Skill | `/contextnest:recall <topic>` | Manual deep retrieval |
| Command | `/contextnest:config` | View/change plugin settings after enable |
| Command | `/contextnest:capture` | Capture on purpose, even when `capture_mode` is `off` |
| Command | `/contextnest:setup` | One-question setup: notes on this computer, online, or both |
| Executable | `bin/ctx` | The bundled CLI, on Claude's `PATH` while the plugin is enabled |

## Local development

The `core/` directory is **vendored** from [`plugins/shared/`](../shared) — do not edit it here. Change the source and re-sync from the repo root:

```bash
pnpm plugins:sync          # regenerate vendored core + agent/skill bodies
pnpm plugins:check         # verify no drift (used in CI)
claude --plugin-dir ./plugins/claude-code --debug
```
