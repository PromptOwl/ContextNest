# Context Nest for Claude Code

Context Nest is a context layer for Claude Code. It gives Claude a shared, governed brain: versioned markdown notes on your computer, or on a server your team shares, that Claude checks when a question needs them and updates when you correct something.

Install it from the directory, then run:

```text
/contextnest:setup
```

Setup asks one question and writes your first note with you. Context Nest is open source under AGPL-3.0, and there's more at [promptowl.ai/contextnest](https://promptowl.ai/contextnest).

## What it does

- **Checks your notes:** when a question depends on your own project, team or past decisions, the `check-notes` skill has Claude search your notes and cite what it used. You can also just say "check my notes".
- **Keeps them current:** say "remember…" or correct something, and the `keep-notes` skill hands it to a background agent. Nothing is saved unless you ask.
- **Consistent corrections:** when you change something the nests record, curator agents find every note carrying the old fact, so the change lands everywhere, not in the first one found.
- **Deep recall:** `/contextnest:recall <topic>` follows the links between notes for a fuller answer.

Everything runs through the existing [`ctx`](https://github.com/PromptOwl/ContextNest/tree/development/packages/cli) CLI, so there is no MCP wiring to do.

## This edition and the full plugin

This directory edition runs nothing automatically. Claude decides when to use your notes, so it can miss a time they would have helped. The full plugin uses hooks to search your notes on every prompt, list your vaults at session start, review finished turns if you turn that on, and check that a correction reached every note. It installs from our own marketplace:

```text
/plugin install contextnest --marketplace promptowl/contextnest
```

Use one edition or the other, because they share the name `contextnest`.

## Setup

Run:

```text
/contextnest:setup
```

It asks one question: **where should Claude keep its notes?**
- **On this computer** (recommended): a private folder, `~/ContextNest/main`, pre-filled for a software project.
- **Online** at nest.promptowl.ai, or your company's server: notes your team can share.
- **Both**.
- **Not now**: nothing changes, and you can run it any time.

It then writes your first real note with you. Re-running it never replaces an existing setup.

Typing `ctx` in a terminal runs the same setup, with the same question and the same folder, so it doesn't matter which one you start with.

Nothing leaves your computer unless you choose to put your notes online.

## Requirements

Node ≥ 20. On a machine without Node, use the nest's MCP server on its own.

The Context Nest CLI comes with the plugin: Claude Code installs it along with the plugin, and Claude can run `ctx` straight away. If you also want `ctx` in your own terminal, install it globally:

```bash
npm i -g @promptowl/contextnest-cli
```

Your own install takes precedence over the bundled copy.

## One server, many nests

Sign in to a Community server once. This registers all its nests:

```text
ctx login https://<server> --as contextnest
```

A server without browser sign-in takes a pasted key instead: add `--key-stdin`.

`ctx vault list` then shows a `contextnest/<nest>` row for every nest you can reach, with each nest's description. Nests shared with you later appear on their own. Claude searches `contextnest` (every nest, in one call) and cites each hit as `contextnest/<nest>:<id>`. Edits go back to that nest, and a new note goes to the nest whose description fits. When none clearly fits, it asks you.

## Choosing which notes come first

This edition has no settings of its own. To change which notes Claude looks in first, run `/contextnest:setup` again, or `ctx vault default <alias>` in a terminal.

## How it decides to touch the vault

A knowledge base earns its keep by being small enough to trust, so both write paths run a ladder and stop at the first rung that resolves. Most candidates never reach the bottom, and silence is the normal outcome.

**Capturing something new.** Can it be stated as a headline plus one "why it matters" sentence? → Will both still be true next month (if not, is it worth an as-of date and a `#time-bound` tag)? → Is it already in the vault? → Would one more sentence on an existing node do? → Is it really just a tag or a title? → only then, the smallest new node.

**Correcting something.** Does the vault actually assert the old value? → Find *every* occurrence before editing, not the first hit → one node, one sentence → several nodes, changed together with the before-marker recorded → structural, which stops and asks.

When the same fact turns out to live in several nodes, fixing all of them is the patch, not the cure: it will need correcting in all of them again next time. The curator says so and offers to make one node canonical with the rest linking to it, offered, never done unasked, because collapsing nodes is structural.

A change is "structural" when the vault would end up contradicting itself, when a node's title or type no longer fits its body, when the corrected term is a concept the vault is organised around (a rename, not an edit), or when a recorded decision has been reversed so the stated reasoning is now wrong. Those are presented for your approval rather than applied.

The ladders are domain-free: the capture agent calibrates what counts as durable from the target vault's own `description`, so a positioning vault and a security vault are judged on their own terms.

## What this plugin runs and sends

**What runs.** This edition has no hooks, so nothing runs on its own. When Claude uses a skill, command or agent, it runs the `ctx` CLI through its Bash tool with your usual permissions: your own install first, then the copy installed with the plugin, then `npx` at the exact version this plugin pins.

**What it downloads.** When you install or update the plugin, Claude Code installs the CLI and its dependencies from `registry.npmjs.org`, at the versions in `package-lock.json`. The `npx` fallback fetches the same CLI version from there.

**What stays on your computer.** With local vaults, your notes stay on your computer. Notes Claude reads are added to your Claude Code conversation, like anything else you show Claude.

**What goes to a server.** Only to servers you add yourself, with `/contextnest:setup`, `ctx login` or `ctx vault add`. When Claude searches those notes, its search words go to those servers, and so do reads and writes for their nests. To stop this, use local notes only. If you configure embeddings for a vault, its search also sends text to the provider you chose. `ctx query @org/pack` fetches a cloud pack from `api.promptowl.ai`, and only when you ask for one.

**Credentials.** The plugin never reads or sends a credential itself. `ctx login` keeps your key in the OS keyring or an encrypted file, and `ctx` sends it to the server it belongs to.

**Telemetry.** Off unless a vault opts in with `telemetry: true` in `.context/config.yaml`. Then `ctx` sends usage events to `api.promptowl.ai`, never vault content, and the vault's welcome page loads Google Analytics. `DO_NOT_TRACK=1` or `CONTEXTNEST_TELEMETRY=0` turns it off whatever the file says.

## Components

| Type | Name | Role |
| --- | --- | --- |
| Skill | `check-notes` | Claude checks your notes when a question needs them |
| Skill | `keep-notes` | Saves what you ask to remember and routes corrections |
| Skill | `/contextnest:recall <topic>` | Manual deep retrieval |
| Agent | `contextnest-retriever` | Digest mode for questions; scout mode returns an occurrence map for writes |
| Agent | `contextnest-capture` | Walks the capture ladder and writes the minimum |
| Agent | `contextnest-curator` | Fixes its assigned scope (nest, or node slice) exhaustively; fanned out in parallel |
| Command | `/contextnest:capture` | Capture on purpose |
| Command | `/contextnest:setup` | One-question setup: notes on this computer, online, or both |
| Executable | `bin/ctx` | The bundled CLI, on Claude's `PATH` while the plugin is enabled |

## Local development

Agent and recall prompt bodies are **vendored** from [`plugins/shared/`](https://github.com/PromptOwl/ContextNest/tree/development/plugins/shared), so do not edit them here. Change the source and re-sync from the repo root:

```bash
pnpm plugins:sync          # regenerate agent/skill bodies
pnpm plugins:check         # verify no drift (used in CI)
claude --plugin-dir ./plugins/claude-code --debug
```
