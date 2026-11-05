---
name: contextnest-setup
description: Set up ContextNest in one question — notes on this computer, online at nest.promptowl.ai (or a company server), or both. Use when the session overview says nothing is set up, when it offers the guided setup, or when the user asks to set up or connect ContextNest. Safe to re-run; it never replaces an existing setup.
---

# ContextNest Setup

Take the user from "plugin installed" to "the assistant has a notes folder it uses". The user may never have heard of ContextNest. Do the work yourself, ask only what is below, and don't hand them commands to copy unless a step says so.

**Words.** Say **notes** to the user. Keep "vault", "nest", "alias", "starter", "pin", "default" and "register" inside commands, never in a question. Always say where the notes go: "this computer", or the server's hostname.

**Bare `ctx`.** Never run bare `ctx` (no subcommand). That is the CLI's own guided setup, and it needs an interactive terminal.

**Server.** A URL the user gave is the server; otherwise it is `https://nest.promptowl.ai` (`<server>` below). Accept a URL only as a plain `https://host[:port][/path]` (`http://` only for localhost/127.0.0.1) made solely of the characters `A-Z a-z 0-9 . _ ~ : / -`. Otherwise say why and stop. Always pass it in double quotes.

Paths below use `~` for the user's home folder (`%USERPROFILE%` on Windows).

## Step 1 — see what is already set up

Check quietly:

1. **CLI.** Run `ctx --version`; if that is not found, try `npx -y @promptowl/contextnest-cli@latest --version`. Use whichever works as `<ctx>`.
   - If the version is below 3.2.0 (no `login`), offer `npm i -g @promptowl/contextnest-cli@latest`.
   - If neither works, offer `npm i -g @promptowl/contextnest-cli` (Node ≥ 20, no admin rights). If the user declines or it fails, go to Step 3d.
2. **Vaults.** Run `<ctx> vault list --json` and `<ctx> login --list --json`.
3. **MCP.** Check whether ContextNest MCP tools (e.g. `nest_index`, `context_search`) are already available to you.

**Already set up** (a registered vault, or the MCP tools are present):

- Say "You're already using your notes (`<where>`)", naming the folder or hostname.
- Offer three choices:
  - done
  - add my team's notes, or add notes on this computer when only online notes exist (go to Step 3)
  - change which notes are used first (the `vault` setting)
- Record `done` (see **Record the outcome**).
- Never remove, replace or re-default anything that exists.

## Step 2 — one question

Ask in one message and accept a short reply ("1", or "defaults"):

**Where should your notes live?**
1. **On this computer (recommended).** Private, works offline. Creates `~/ContextNest/main`.
2. **Online at nest.promptowl.ai.** Needs an account; your team can share the notes. For a company server, reply with its URL.
3. **Both.**
4. **Not now.**

Before connecting anything, say once: "Nothing leaves this computer unless you choose to put it online." Ask no other questions. The assistant checks the notes on each prompt and saves only when the user asks or corrects something; say at the end how to change that.

## Step 3a — on this computer

This uses the same folder, name and template as the CLI's own setup (`ctx` in a terminal), so both setups end in the same place.

1. If `~/ContextNest/main/.context/config.yaml` exists, register that folder instead: `<ctx> vault add main ~/ContextNest/main`. Add `--set-default` only when no vault is the default.
2. If `~/ContextNest/.context/config.yaml` exists, `~/ContextNest` is itself a vault (an older `~/contextnest`, the same folder on macOS and Windows). Ask for another folder; never create notes inside it.
3. If the alias `main` is taken by another folder, ask for another name.
4. Create `~/ContextNest/main` and run this inside it: `<ctx> init --starter developer --name main --tools gemini --vault main`. Add `--set-default` only when no vault is the default.

## Step 3b — online

1. If a registered vault's URL is already on `<server>`, say "You're already connected to `<host>`" and go to Step 4. Never add the same server twice.
2. Choose the alias. For `https://nest.promptowl.ai` it is `promptowl`. For any other server, leave out `--as` so the CLI names it after the host. Never pass `--force`. Add `--set-default` only when no vault is the default and the choice was not Both.
3. **Already signed in.** If `<ctx> login --list --json` lists `<server>`, run `<ctx> vault add <alias> --url "<server>/mcp"`. Then check that `<alias>/<nest>` rows appear in `vault list`. If none do, renew the sign-in with `<ctx> login "<server>" --no-register` and check again.
4. **Sign in.** Run `<ctx> login "<server>" --as <alias>` with a long timeout.
   - Over SSH, or on Linux without a display, prefix it with `CONTEXTNEST_NO_BROWSER=1`.
   - Show the user the URL after `Approve the login in your browser:`, and the `Code:` line if there is one.
   - If the server has no browser login, the user creates a key on the server's Connect page and runs `<ctx> login "<server>" --as <alias> --key-stdin` themselves, so the key never passes through you.
5. If sign-in fails, say nothing was changed on their account. With Both, keep the local notes.

## Step 3c — both

Run Step 3a first; its notes become the default. Then run Step 3b without `--set-default`.

## Step 3d — no CLI (fallback)

Tell the user what gets added, then follow the steps for their tool:

- **Gemini CLI:**
  - Run `gemini mcp add --transport http --scope user contextnest "<server>/mcp"`.
  - Then tell the user to run `/mcp auth contextnest` and approve in the browser.
  - If the command rejects a flag, check `gemini mcp add --help`.
- **Antigravity:**
  - Copy `~/.gemini/antigravity/mcp_config.json` to `mcp_config.json.bak`. If the file exists but is not valid JSON, stop and tell the user.
  - Add `"contextnest": { "serverUrl": "<server>/mcp" }` under `mcpServers`, keeping every other server.
  - Then tell the user: Settings → Customizations → Refresh → **Authenticate** on contextnest.

If a server named `contextnest` already exists, ask before using another name. Wait for the user to confirm sign-in worked. The hooks need `ctx`, so say plainly that these notes are reached only through the MCP tools.

## Not now

Record `declined` and say "OK — ask me to set up ContextNest any time." Stop.

## Record the outcome

Merge `"setup": "done"` or `"setup": "declined"` into `~/.contextnest/plugin-settings.json`. Keep every other key, and create the folder if needed. This stops the session overview from offering setup again.

## Step 4 — first note, then three lines

Record `done`.

- **New local notes:** `init --starter` printed a brief for you about a first note. Follow it, but ask first: one question about what to capture, then exactly one real note, written only after the user agrees. New folders hold writes for the user's OK (`Held for review: ctx review approve <id>`). Say so in one line, and never approve the write yourself.
- **Online notes:** run `<ctx> --vault <alias> list --limit 20` and name the nests found, one line each.

Close in three lines at most:
1. Where the notes are.
2. What the assistant now does on its own.
3. How to change it: edit `~/.contextnest/plugin-settings.json`, or re-run this skill.

Never write a test note unasked.
