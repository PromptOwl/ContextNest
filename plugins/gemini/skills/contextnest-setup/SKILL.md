---
name: contextnest-setup
description: Connect ContextNest in one guided step — PromptOwl cloud, a company server, or notes only on this computer — and choose how much runs on its own. Use when the session overview says no nest is connected, when it offers the guided setup, or when the user asks to set up or connect ContextNest. Safe to re-run; it never replaces an existing setup.
---

# ContextNest Setup

Walk the user from "plugin installed" to "nest connected and the agent knows how to use it". The user may know nothing about ContextNest — do the work, ask only the choices below, and never hand them a command to copy unless a step says so.

Say this once, before connecting anything: **connecting uploads nothing.** Notes in a local vault stay on this machine unless the user runs `ctx push`; only what is written to a hosted nest lives on that server.

A server URL (`<server>`) is accepted only as a plain `https://host[:port][/path]` (`http://` only for localhost/127.0.0.1) made solely of the characters `A-Z a-z 0-9 . _ ~ : / -`; otherwise say why and stop. Always pass it to commands in double quotes.

Paths below use `~` for the user's home folder (`%USERPROFILE%` on Windows).

## Step 1 — see what is already set up

Check quietly:

1. **MCP** — are ContextNest MCP tools already available to you (e.g. `nest_index`, `context_search`)?
2. **CLI** — `ctx --version`; if not found, `npx -y @promptowl/contextnest-cli@latest --version`. Use whichever works as `<ctx>`. Below 3.2.0 there is no `login` command — offer `npm i -g @promptowl/contextnest-cli@latest`.
3. **Vaults** — with a CLI, `<ctx> vault list --json` (and `<ctx> login --list` when it has `login`).

Already connected → show a short summary and ask: done, connect another nest, or pin a vault. Never remove, replace or re-default anything that exists.

## Step 2 — three choices, one message

Ask all three in **one** message, numbered, with the recommended answer first, and accept a short reply (e.g. "1a 2a 3a", or "defaults"):

1. **Where do your notes live?** a) PromptOwl cloud (recommended) → `https://nest.promptowl.ai` · b) only on this computer (private local vault) · c) a company server — reply with its URL.
2. **How should the assistant use them?**
   - a) **Light** (recommended) — looks up matching notes on each prompt, saves only when asked → `retrieval_mode: search`, `capture_mode: off`.
   - b) **On demand** — cheapest, nothing runs in the background → `off` / `off`.
   - c) **Hands-free** — also proposes notes worth keeping (a background review each time, roughly 25k tokens) → `search` / `propose`.

   Leave this question out when there is no usable CLI and the answer to 1 is not b — the hooks it configures need `ctx`.
3. **Apply to** a) all projects (recommended) · b) this project only. This scopes the plugin settings and the MCP entry; a `ctx` sign-in or a new local vault is still registered for the whole user account — say so when it applies.

Then pick the path: 1b → Step 3c. A server and a CLI of 3.2.0 or later → Step 3b. A server and no usable CLI → Step 3a.

## Step 3a — cloud (MCP + browser sign-in)

Tell the user what gets added, then:

- **Gemini CLI:** `gemini mcp add --transport http --scope <user|project> contextnest "<server>/mcp"`, then tell the user to run `/mcp auth contextnest` and approve in the browser. If the command rejects a flag, check `gemini mcp add --help` and adapt — these flags are not confirmed for every version.
- **Antigravity:** add `"contextnest": { "serverUrl": "<server>/mcp" }` under `mcpServers` in `~/.gemini/antigravity/mcp_config.json` (merge; keep every other server), then tell the user: Settings → Customizations → Refresh → **Authenticate** on contextnest. Copy the file to `mcp_config.json.bak` first; if it exists but is not valid JSON, stop and tell the user rather than rewriting it.

If a server named `contextnest` already exists, ask before using another name. Wait for the user to confirm sign-in worked. If no sign-in is offered, remove only the entry you added and offer Step 3b.

## Step 3b — local CLI

1. No CLI → offer `npm i -g @promptowl/contextnest-cli` (Node ≥ 20, no admin rights). If it fails, offer Step 3a.
2. `<ctx> login "<server>" --as promptowl` — add `--set-default` only when no default exists; never `--force`; another alias if `promptowl` is taken. It opens the browser and waits: run it with a long timeout and tell the user to approve. On a server without browser login, the user creates a key in the web UI and runs `<ctx> login "<server>" --as promptowl --key-stdin` themselves — the key never passes through you.
3. Confirm with `<ctx> vault list --json` (each nest shows as `promptowl/<nest>`); with several nests, offer to pin one.

## Step 3c — only on this computer

Needs the CLI (as in 3b). Create `~/contextnest` (or a folder the user names; if it exists and is not empty, ask for another — never `init` over a vault), run `<ctx> init --name "My notes"` inside it (`--set-default` only when no default exists) and use the alias it printed. If question 2 was left out, apply **Light**.

## Step 3d — apply the usage choice

Write `retrieval_mode` and `capture_mode` (merge, keep other keys) to `~/.contextnest/plugin-settings.json` for all projects, or `.claude/contextnest.local.json` in the project root for this project only (the path is shared with the Claude Code plugin, so a `.claude/` folder appearing in a Gemini-only project is expected; add the file to `.gitignore`). With no CLI, write `off` / `off` and say why: the hooks need `ctx`, so you use the nest's MCP tools directly. On the cloud path with a CLI present, say the hooks cover only `ctx` vaults; this nest is reached through its MCP tools.

## Step 4 — learn the nest, then prove it works

Do not write usage rules from memory — the nest is the source of truth.

- MCP: `nest_index`, then `context_overview`; read any guide or onboarding node they surface.
- CLI: `<ctx> --vault <alias> list --limit 20` and `<ctx> --vault <alias> structure --json`.

Show it works with one real search and cite one hit as `vault:id`. Finish in three lines at most: what is connected, what the assistant now does on its own, and how to change it (edit the settings file above, or re-run this skill). Ask before writing a test note.
