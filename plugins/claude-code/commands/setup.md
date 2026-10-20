---
description: Connect Context Nest in one guided step — PromptOwl cloud, your company's server, or notes only on this computer — and choose how much it runs on its own. Safe to re-run; it never replaces an existing setup.
argument-hint: "[cloud|local] [server-url]"
---

# Context Nest setup

Walk the user from "plugin installed" to "nest connected and the agent knows how to use it". The user may know nothing about Context Nest — do the work, ask only the choices below, and never hand them a command to copy unless a step says so.

Server: the URL in `$ARGUMENTS` if one was given, else the one chosen in Step 2 (`https://nest.promptowl.ai` for PromptOwl cloud). Call it `<server>` below. Accept it only if it is a plain `https://host[:port][/path]` URL (`http://` only for localhost/127.0.0.1) with no spaces, quotes or shell characters; otherwise say why and stop. Always pass it to commands in double quotes.

Say this once, before connecting anything: **connecting uploads nothing.** Notes in a local vault stay on this machine unless the user runs `ctx push`; only what is written to a hosted nest lives on that server.

## Step 1 — see what is already set up

Check all three, quietly:

1. **MCP** — are tools from a Context Nest MCP server already available to you in this session (e.g. `nest_index`, `context_search`)?
2. **CLI** — run `ctx --version`. Not found → `npx -y @promptowl/contextnest-cli --version`. Use whichever works as `<ctx>` from here on; neither → no CLI. A version below 3.2.0 has no `login` command: treat it as too old for Step 3b and offer `npm i -g @promptowl/contextnest-cli@latest`, or use `npx -y @promptowl/contextnest-cli@latest` as `<ctx>` instead.
3. **Vaults** — with a CLI, run `<ctx> vault list --json`, and `<ctx> login --list` when the CLI has `login`.

An MCP server or claude.ai connector that already points at `<server>` but needs sign-in counts as the cloud path half done: ask Step 2 without its first question, then go to Step 3a item 2 for that server instead of adding another.

**Already connected** (MCP tools present, or at least one registered vault): if `$ARGUMENTS` names `cloud` or `local`, treat it as **Connect another nest** and go on without asking. Otherwise show a short summary (what is connected, which vault is default/pinned) and ask with `AskUserQuestion`: **Done** · **Connect another nest** (continue at Step 2) · **Pin a vault** (hand over to `/contextnest:config vault`). Never remove, replace, or re-default anything that already exists.

## Step 2 — three choices, one question screen

Ask all three in a single `AskUserQuestion` call; leave out any question `$ARGUMENTS` already answers (a URL answers the first).

1. **Where do your notes live?** — **PromptOwl cloud (recommended)** → `https://nest.promptowl.ai` · **Only on this computer** → a private local vault, nothing connects to a server. A company server is typed into "Other" as its URL.
2. **How should the assistant use them?** — show the cost in each label:
   - **Light (recommended)** — looks up matching notes on each prompt (no extra AI call, a few hundred tokens only when something matches); notes are saved only when you ask. → `retrieval_mode: search`, `capture_mode: off`.
   - **On demand — cheapest** — nothing runs in the background; you ask, or use `/contextnest:recall` and `/contextnest:capture`. → `off` / `off`.
   - **Hands-free** — also reviews finished turns and proposes notes worth keeping (each review is a background agent run, roughly 25k tokens). → `search` / `propose`.
3. **Apply to** — **All projects (recommended)** · **This project only**.

Then pick the path: **Only on this computer** → Step 3c. A server and a CLI of 3.2.0 or later → Step 3b. A server and no usable CLI → Step 3a. `cloud` or `local` in `$ARGUMENTS` forces 3a or 3b.

## Step 3a — cloud (MCP + browser sign-in)

1. Tell the user it adds a `contextnest` entry to their MCP config, then run `claude mcp add --transport http --scope <scope> contextnest "<server>/mcp"` — `<scope>` is `user` for all projects, `local` for this project only. If a server named `contextnest` already exists, ask before using another name — never remove the existing one.
2. Tell the user, in one short message: run `/mcp`, pick **contextnest** (or the existing server/connector found in Step 1), choose **Authenticate**, and approve in the browser. If `contextnest` does not show in `/mcp`, restart Claude Code first.
3. Stop here and wait. Once they say it worked, go to Step 3d. If `/mcp` offers no **Authenticate** or the sign-in fails, the server has browser sign-in turned off — remove the `contextnest` entry you added (`claude mcp remove contextnest --scope <scope>`) and offer the local CLI path instead.
4. The sign-in may grant read access only. If a write is later refused for a missing scope, say so plainly and offer the local CLI path for writing.

## Step 3b — local CLI

1. No CLI at all → offer `npm i -g @promptowl/contextnest-cli` (needs Node ≥ 20; installs to the user's npm prefix, no admin rights). If it fails, offer the cloud path instead of debugging the machine.
2. Sign in and register the server as one alias covering every nest: `<ctx> login "<server>" --as promptowl` — add `--set-default` only when `vault list` showed no default. If `promptowl` is taken, pick another alias; never pass `--force`. The command opens the browser and waits for approval: run it with a long timeout (10 min) and tell the user to approve the page that opened. On a server without browser login it asks for a pasted key — tell the user to create one in the server's web UI (Connect) and run `! <ctx> login "<server>" --as promptowl --key-stdin` themselves, so the key never passes through you.
3. Confirm with `<ctx> vault list --json`: each nest shows as `promptowl/<nest>`.
4. More than one nest → ask with `AskUserQuestion` whether to pin one (each nest as an option, labelled with its description, plus **Don't pin — choose per question**). Pinning writes `vault` the way `/contextnest:config` does. Then go to Step 3d.

## Step 3c — only on this computer

Needs the CLI (install as in Step 3b item 1; if that fails, say a local vault needs it and offer PromptOwl cloud). Create `~/contextnest` (or another folder the user names), and inside it run `<ctx> init --name "My notes"` — add `--set-default` only when `vault list` showed no default. Nothing leaves the machine. Then go to Step 3d.

## Step 3d — apply the usage choice

Write the Step 2 choice as `retrieval_mode` and `capture_mode`, the way `/contextnest:config` does (its Step 3 merge rules; `--global` for all projects). With no CLI on this machine, write `off` / `off` whatever was chosen and say why: the hooks need `ctx`, so you use the nest's MCP tools directly instead. Then go to Step 4.

## Step 4 — learn the nest, then prove it works

Do not write usage rules from memory — the nest is the source of truth, and it changes without a plugin release.

- MCP: call `nest_index`, then `context_overview`. Read any guide or onboarding node they surface and follow it.
- CLI: `<ctx> --vault <alias> list --limit 20` and `<ctx> --vault <alias> structure --json`, where `<alias>` is the vault just connected (`promptowl` or the new local vault).

Then show the user it works with one real read: search for something the nest is about and cite one hit. Finish with three lines at most — what is connected, what the agent now does on its own (per the usage choice), and how to change it (`/contextnest:config`). Ask before writing a test note; never write one unasked.
