# Plan: the coding plugin uses the new `ctx` first-run onboarding

Status: draft (pending user-persona review)
Depends on: PR #228 (`feat(cli,engine): first-run onboarding for bare ctx`, CU-wdqcq067kw)
Touches: `plugins/claude-code/commands/setup.md`, `plugins/shared/core/session-start.js`, `plugins/gemini/skills/contextnest-setup/SKILL.md`, plugin README/CHANGELOG, plugin tests

## 1. Problem

PR #228 gives the CLI a first-run setup: the first bare `ctx` in a terminal asks
"Where should your vault live?" (this machine / team server / both / skip) and
creates `~/ContextNest/main` with the `developer` starter, or signs in to
`https://nest.promptowl.ai` as `promptowl`.

The Claude Code plugin already has its own setup (`/contextnest:setup`), and the
two now disagree:

| | `ctx` first run (PR #228) | `/contextnest:setup` today |
|---|---|---|
| Question | "Where should your vault live?" | "Where do your notes live?" |
| Recommended | On this machine | PromptOwl cloud |
| Both local + server | yes | no |
| Local folder | `~/ContextNest/main`, alias `main` | `~/contextnest`, alias derived, name "My notes" |
| Starter | `developer` | none (empty vault) |
| Agent config | `--tools <detected>` | not passed |
| Already signed in to the server | reuses the saved key (`vault add`), no browser | runs `login` again |
| No browser (SSH / no display) | prints the link | link is in Bash output the user can't see while `login` waits up to 10 min |

So a user who sets up in the plugin and later types `ctx` in a terminal (or the
other way round) meets two different vocabularies and can end up with two
vaults in two places. On macOS/Windows `~/contextnest` and `~/ContextNest` are the
same folder, so the new default would land *inside* an old plugin-made vault.

A second gap: the new onboarding only runs in a real terminal. The agent's Bash
tool is not one, so if the agent follows the new README ("run `ctx`") it gets
help text plus "Run `ctx` in a terminal to get set up." and may relay that to
the user instead of running the plugin's setup.

## 2. Goal

One setup, two front doors. Whether the user types `ctx` in a terminal or runs
`/contextnest:setup` in Claude Code, they see the same choices in the same words
and end with the same vault in the same place. Either door, once finished, makes
the other one quiet.

## 3. Approach

The CLI flow (`runOnboarding` in `packages/cli/src/first-run.ts`) is only a
script over two existing commands: `ctx init` and `ctx login` / `ctx vault add`.
The plugin can run the very same commands with the very same arguments. No new
CLI command is needed.

Rejected for now: a non-interactive `ctx onboard --local|--server|--both`. It
would give one code path, but it is new public CLI surface for something the
plugin can already do in two commands. Revisit if a third agent plugin needs it.

Drift guard: export `DEFAULT_ALIAS` and `DEFAULT_STARTER` from `first-run.ts`
and add a plugin test that checks `setup.md` and the Gemini setup skill name the
same server, folder, alias, starter and `--as promptowl`.

## 4. Changes

### 4.1 `/contextnest:setup` (`plugins/claude-code/commands/setup.md`)

1. **Question 1 uses the CLI's words.** "Where should your vault live?"
   - **On this machine** — creates `~/ContextNest/main` with the developer template; works offline, no account.
   - **On a team server** — sign in at nest.promptowl.ai (a company server URL goes in "Other").
   - **Both** — the local vault is the default; the server is added beside it.

   Recommended: **On this machine** when `ctx` is available (matches the CLI);
   **On a team server** when it is not, because that path needs no install.
2. **Local path matches the CLI exactly.** In `~/ContextNest/main`:
   `ctx --yes --vault main init --starter developer --name main --tools claude`
   plus `--set-default` only when no default exists. Then:
   - `~/ContextNest/main` already holds a vault → register it (`ctx vault add main ~/ContextNest/main`) instead of creating one.
   - `~/ContextNest` itself is a vault (an old plugin-made `~/contextnest` on a case-insensitive disk) → don't nest a vault inside it; ask for another folder.
   - Alias `main` taken → ask for another name.
   - A different template, name or folder is offered as one "Customize" follow-up, not by default.
3. **Server path reuses a saved sign-in.** If `ctx login --list --json` already
   has the server, run `ctx vault add promptowl --url "<server>/mcp"` (no
   browser), then check the nests appear in `ctx vault list --json`; if they
   don't, fall back to a fresh `login`.
4. **The sign-in link is always visible.** Run `ctx login` in the background,
   read its output for the "Approve the login in your browser" link (and code),
   and post it in the chat. On SSH or a machine with no display, set
   `CONTEXTNEST_NO_BROWSER=1` so nothing tries to open a browser that isn't there.
5. **Both** = local first (default), then the server without `--set-default`,
   the same order as the CLI. If the server half fails, keep the local vault and
   say how to retry.
6. **Finish like the CLI**: what is connected, a few items from the new vault,
   and the next step phrased for Claude Code (just ask; `/contextnest:recall`;
   `/contextnest:capture`). Mention once that `ctx` in a terminal shows all
   commands.

Unchanged: the usage question (Light / On demand / Hands-free), the scope
question, the cloud-MCP path when there is no CLI, "never replace an existing
setup", "connecting uploads nothing".

### 4.2 Session overview (`plugins/shared/core/session-start.js`)

`SETUP_HINT` gains one sentence: don't run bare `ctx` to set up from here, its
guided setup needs an interactive terminal; use `/contextnest:setup` (or the
user can type `ctx` in their own terminal for the same setup). Then
`pnpm plugins:sync`.

### 4.3 Gemini setup skill (`plugins/gemini/skills/contextnest-setup/SKILL.md`)

Same changes as 4.1 (question wording, folder, starter, `--tools gemini`,
saved sign-in, visible link, Both).

### 4.4 Docs and release

- `plugins/claude-code/README.md` Setup: running `ctx` in a terminal and
  `/contextnest:setup` are the same setup and end in the same vault.
- Plugin `0.7.0 → 0.8.0`, CHANGELOG entry.

### 4.5 Tests

- `plugins/__tests__/core.unit.test.ts`: the no-vault overview says not to run bare `ctx`.
- New drift test (section 3).
- No new CLI tests: the plugin only calls `init`, `login`, `vault add`, which already have them.

## 5. Out of scope

- A non-interactive `ctx onboard` command (section 3).
- Writing `onboarded_at` / `skipped_at` from the plugin. A plugin-made vault already makes the next bare `ctx` treat the user as existing and mark them silently.
- Changing `ctx login` itself (copy-code screen, nest picker), as PR #228 also leaves out.
- Codex (README-only plugin).

## 6. Open questions

1. If the user chose **Skip** in the terminal, should the plugin stop offering setup? Today the overview offers it every session with no vault. Reading the skip marker needs a small CLI change (it is not in `ctx vault list --json`).
2. Should the plugin keep a "PromptOwl cloud" label anywhere, or is "team server" clear enough for a solo user?

## 7. Steps to test

1. Use a clean machine profile: `export CONTEXTNEST_CONFIG_DIR=$(mktemp -d)` and an empty `HOME`, install the plugin, start Claude Code.
2. Run `/contextnest:setup`, choose **On this machine**, Light, All projects. Expect `~/ContextNest/main` created with the developer template, registered as `main` (default), and a few of its items listed.
3. In a terminal, run `ctx`. Expect plain help (no setup menu), exit code 0.
4. Reset, run `ctx` in a terminal first and press Enter twice. Then run `/contextnest:setup`. Expect "already connected" with `main`, and no second vault.
5. Reset, run `/contextnest:setup`, choose **On a team server**. Expect the approval link shown in the chat, and after approval `promptowl/<nest>` rows.
6. Repeat 5 when already signed in (`ctx login --list` shows the server). Expect no browser, the nests connected straight away.
7. Choose **Both**. Expect `main` as default and `promptowl/<nest>` beside it.
8. In a session with no vault, ask Claude "set up context nest". Expect it to run `/contextnest:setup`, not to tell you to open a terminal.
