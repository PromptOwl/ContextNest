---
description: Connect Context Nest in one guided step — sign in to a hosted nest (no install needed) or set up the local ctx CLI. Safe to re-run; it never replaces an existing setup.
argument-hint: "[cloud|local] [server-url]"
---

# Context Nest setup

Walk the user from "plugin installed" to "nest connected and the agent knows how to use it". The user may know nothing about Context Nest — do the work, ask only the choices below, and never hand them a command to copy unless a step says so.

Server: the URL in `$ARGUMENTS` if one was given, else `https://nest.promptowl.ai`. Call it `<server>` below.

Say this once, before connecting anything: **connecting uploads nothing.** Notes in a local vault stay on this machine unless the user runs `ctx push`; only what is written to a hosted nest lives on that server.

## Step 1 — see what is already set up

Check all three, quietly:

1. **MCP** — are tools from a Context Nest MCP server already available to you in this session (e.g. `nest_index`, `context_search`)?
2. **CLI** — run `ctx --version`. Not found → `npx -y @promptowl/contextnest-cli --version`. Use whichever works as `<ctx>` from here on; neither → no CLI. A version below 3.2.0 has no `login` command: treat it as too old for Step 3b and offer `npm i -g @promptowl/contextnest-cli@latest`, or use `npx -y @promptowl/contextnest-cli@latest` as `<ctx>` instead.
3. **Vaults** — with a CLI, run `<ctx> vault list --json`, and `<ctx> login --list` when the CLI has `login`.

**Already connected** (MCP tools present, or at least one registered vault): show a short summary (what is connected, which vault is default/pinned) and ask with `AskUserQuestion`: **Done** · **Connect another nest** (continue at Step 2) · **Pin a vault** (hand over to `/contextnest:config vault`). Never remove, replace, or re-default anything that already exists.

## Step 2 — pick a path

`cloud` or `local` in `$ARGUMENTS` skips this question. Otherwise ask with `AskUserQuestion`:

- **Cloud — recommended, nothing to install.** Sign in in the browser; works without admin rights. Pre-select this when there is no CLI.
- **Local CLI.** Uses `ctx` on this machine; also unlocks the plugin's auto-retrieval and capture hooks, which need the CLI.

## Step 3a — cloud (MCP + browser sign-in)

1. Run `claude mcp add --transport http --scope user contextnest <server>/mcp`. If a server named `contextnest` already exists, ask before using another name — never remove the existing one.
2. Tell the user, in one short message: run `/mcp`, pick **contextnest**, choose **Authenticate**, and approve in the browser. If `contextnest` does not show in `/mcp`, restart Claude Code first.
3. Stop here and wait. Once they say it worked, go to Step 4. If `/mcp` offers no **Authenticate** or the sign-in fails, the server has browser sign-in turned off — remove the `contextnest` entry you added (`claude mcp remove contextnest --scope user`) and offer the local CLI path instead.
4. The sign-in may grant read access only. If a write is later refused for a missing scope, say so plainly and offer the local CLI path for writing.
5. No CLI on this machine → the plugin's retrieval and capture hooks cannot run and would only slow every prompt. Set `"retrieval_mode": "off"` and `"capture_mode": "off"` in `~/.contextnest/plugin-settings.json` (merge, keep other keys) and tell the user why: in this mode you use the nest's MCP tools directly.

## Step 3b — local CLI

1. No CLI at all → offer `npm i -g @promptowl/contextnest-cli` (needs Node ≥ 20; installs to the user's npm prefix, no admin rights). If it fails, offer the cloud path instead of debugging the machine.
2. Sign in and register the server as one alias covering every nest: `<ctx> login <server> --as promptowl` — add `--set-default` only when `vault list` showed no default. If `promptowl` is taken, pick another alias; never pass `--force`. The command opens the browser and waits for approval: run it with a long timeout (10 min) and tell the user to approve the page that opened. On a server without browser login it asks for a pasted key — tell the user to create one in the server's web UI (Connect) and run `! <ctx> login <server> --as promptowl --key-stdin` themselves, so the key never passes through you.
3. Confirm with `<ctx> vault list --json`: each nest shows as `promptowl/<nest>`. If `~/.contextnest/plugin-settings.json` has `retrieval_mode` or `capture_mode` set to `off` from an earlier cloud setup, ask whether to turn them back on (`search` / `propose`).
4. More than one nest → ask with `AskUserQuestion` whether to pin one (each nest as an option, labelled with its description, plus **Don't pin — choose per question**). Pinning writes `vault` the way `/contextnest:config` does.

## Step 4 — learn the nest, then prove it works

Do not write usage rules from memory — the nest is the source of truth, and it changes without a plugin release.

- MCP: call `nest_index`, then `context_overview`. Read any guide or onboarding node they surface and follow it.
- CLI: `<ctx> --vault promptowl list --limit 20` and `<ctx> structure --json` for the target nest.

Then show the user it works with one real read: search for something the nest is about and cite one hit. Finish with three lines at most — what is connected, what the agent now does on its own (retrieves before answering; proposes notes worth keeping), and how to change it (`/contextnest:config`). Ask before writing a test note; never write one unasked.
