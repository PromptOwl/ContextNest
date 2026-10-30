---
description: Set up Context Nest in one question — notes on this computer, online at nest.promptowl.ai (or your company's server), or both. Safe to re-run; it never replaces an existing setup.
argument-hint: "[local|online|both] [server-url]"
allowed-tools: Bash(ctx --version), Bash(ctx vault list:*), Bash(ctx vault which:*), Bash(ctx login --list:*), Bash(ctx init:*), Bash(ctx login:*), Bash(ctx vault add:*), Bash(ctx list:*), Bash(ctx structure:*), Bash(mkdir -p:*)
---

# Context Nest setup

Take the user from "plugin installed" to "Claude has a notes folder it uses". The user may never have heard of Context Nest. Do the work yourself, ask only what is below, and don't hand them commands to copy unless a step says so.

**Words.** Say **notes** to the user. Keep "vault", "nest", "alias", "starter", "pin", "default" and "register" inside commands; never make them part of a question. Always say where the notes go: "this computer", or the server's hostname.

**`ctx`.** The plugin ships the Context Nest CLI and puts `ctx` on your Bash `PATH`. A copy the user installed themselves comes first. Never run bare `ctx` (with no subcommand): that is the CLI's own guided setup, and it needs an interactive terminal.

**Server.** A URL in `$ARGUMENTS` is the server; otherwise it is `https://nest.promptowl.ai`. Call it `<server>` below. Accept a URL only if it is a plain `https://host[:port][/path]` (`http://` only for localhost/127.0.0.1) with no spaces, quotes or shell characters; otherwise say why and stop. Always pass it in double quotes.

## Step 1 — see what is already set up

Check quietly:

1. `ctx --version`. If it fails, the bundled CLI is missing too, for example because the plugin's automatic install failed. Offer `npm i -g @promptowl/contextnest-cli` (Node ≥ 20, no admin rights). If the user says no or it fails, go to **Step 3d**.
2. `ctx vault list --json` and `ctx login --list --json`.
3. Whether Context Nest MCP tools (e.g. `nest_index`, `context_search`) are already available to you in this session.

**Already set up** means at least one registered vault, or the MCP tools are present. If so, and `$ARGUMENTS` names no path, say "Claude is already using your notes (`<where>`)." Name the folder, or the hostname for online notes. Then ask with `AskUserQuestion`:

- **Done**
- **Add my team's notes** (or **Add notes on this computer** when only online notes exist) → the matching path in Step 3
- **Change which notes Claude uses first** → hand over to `/contextnest:config vault`

Write `"setup": "done"` (see **Record the outcome**). Never remove, replace or re-default anything that exists.

## Step 2 — one question

Skip this when `$ARGUMENTS` says `local`, `online` (or `cloud`) or `both`. A URL alone means online. Otherwise ask with one `AskUserQuestion`:

**Where should Claude keep its notes?**
- **On this computer (recommended)** — private, works offline. Creates `~/ContextNest/main`.
- **Online at nest.promptowl.ai** — needs an account; your team can share the notes. (A company server: type its URL in "Other".)
- **Both** — on this computer, plus your team's online notes.
- **Not now**

Always recommend this computer, the same default as the CLI's own setup. Before connecting anything, say once: "Nothing leaves this computer unless you choose to put it online."

There are no other questions. Claude checks the notes on each prompt and saves only when the user asks or corrects something (the plugin's default). Say at the end how to change that.

## Step 3a — on this computer

These are the same folder, name and template as the CLI's own setup (`ctx` in a terminal), so both end up in the same place.

1. If `~/ContextNest/main/.context/config.yaml` exists, those notes already exist. Add them instead of creating anything: `ctx vault add main ~/ContextNest/main` (add `--set-default` only when `vault list` showed no default). Go to Step 4.
2. If `~/ContextNest/.context/config.yaml` exists, `~/ContextNest` is itself a vault. An older setup made `~/contextnest`, which is the same folder on macOS and Windows. Don't create notes inside it. Ask for another folder.
3. If the alias `main` is taken by another folder, ask for another name.
4. Run `mkdir -p ~/ContextNest/main`, then in that folder:
   `ctx init --starter developer --name main --tools claude --vault main`
   Add `--set-default` only when `vault list` showed no default.
5. If the user asked for a different template, name or folder (in "Other"), use theirs. Templates: `ctx init --list-starters`.

## Step 3b — online

1. If `ctx vault list --json` already has a vault whose URL is on `<server>`, say "You're already connected to `<host>` (N nests)." and go to Step 4. Never add the same server twice.
2. The alias is `promptowl` for `https://nest.promptowl.ai`. For any other server, leave `--as` out and `ctx` names it after the host. If `promptowl` is taken, pick another. Never pass `--force`. Add `--set-default` only when no vault is the default and this is not **Both**.
3. **Already signed in.** If `ctx login --list --json` lists `<server>`, run `ctx vault add <alias> --url "<server>/mcp"` with no browser. Then check that `ctx vault list --json` shows `<alias>/<nest>` rows. If it shows none, the saved sign-in has expired: run `ctx login "<server>" --no-register` (item 4) to renew it, then check again.
4. **Sign in.** Run `ctx login "<server>" --as <alias>` **in the background** (`run_in_background`). The user can't see Bash output while it waits for approval.
   - Over SSH, or on Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY`, prefix it with `CONTEXTNEST_NO_BROWSER=1`.
   - Read its output until the line `Approve the login in your browser:` and the URL after it, and a `Code:` line if there is one. Post both in the chat: "Approve the sign-in here: <url> (code …)".
   - Wait for the command to finish.
   - A server without browser sign-in asks for a pasted key instead. Tell the user to create one on the server's Connect page and run `! ctx login "<server>" --as <alias> --key-stdin` themselves, so the key never passes through you.
5. If sign-in fails, say nothing was changed on their account and how to retry. With **Both**, keep the local notes.

## Step 3c — both

Step 3a first; its notes become the default. Then Step 3b without `--set-default`.

## Step 3d — no CLI at all (fallback)

Only when Step 1 found no working `ctx` and the user declined the npm install. Tell them it adds a `contextnest` entry to their MCP config. Then:

1. Run `claude mcp add --transport http --scope user contextnest "<server>/mcp"`. If a server named `contextnest` exists, ask before using another name, and never remove the existing one.
2. Tell the user to run `/mcp`, pick **contextnest**, choose **Authenticate**, and approve in the browser. If it doesn't show, restart Claude Code first.
3. Wait for them to say it worked. If there is no **Authenticate** option, remove only the entry you added (`claude mcp remove contextnest --scope user`) and say a local setup needs Node.
4. The hooks need `ctx`, so say plainly that Claude reaches these notes only through the MCP tools.

## Not now

Write `"setup": "declined"` and say "OK — run /contextnest:setup any time." Stop.

## Record the outcome

Merge the `setup` key into `~/.contextnest/plugin-settings.json`: read it, keep every other key, create the folder if needed, and write pretty JSON. The values are `"done"` (set up, or already set up) and `"declined"` (Not now). This is what stops the "isn't set up yet" message at session start.

## Step 4 — first note, then three lines

Write `"setup": "done"`.

- **New local notes.** `ctx init --starter` printed a brief addressed to you about a first note. Follow it, but ask first: one question about what to capture first, then exactly one real note, written only after the user agrees. Don't read the brief out to them. Don't search the new folder to "prove it works": it holds only template pages. New notes folders hold Claude's writes for the user's OK, so `ctx` prints `Held for review: ctx review approve <id>`. Tell the user in one line that the note is waiting for them and how to approve it. Never approve it yourself.
- **Online notes.** Run `ctx --vault <alias> list --limit 20` and `ctx --vault <alias> structure --json`. Name the nests you found in one line each.

Then close in at most three lines:

1. Where the notes are (the folder or hostname).
2. What Claude now does on its own: checks the notes on each prompt, and saves when you say "remember…" or correct it.
3. How to change that: `/contextnest:config`.

If `command -v ctx` points inside the plugin's own folder, the user has no `ctx` of their own. Offer once: "Want `ctx` in your own terminal too? `npm i -g @promptowl/contextnest-cli`". Never write a test note unasked.
