# Plan: the coding plugin uses the new `ctx` first-run onboarding

Status: proposed (reviewed by a newcomer-persona agent, findings folded in, see section 8)
Task: CU-wdqcq067m5 (https://app.clickup.com/t/wdqcq067m5)
Depends on: PR #228 (`feat(cli,engine): first-run onboarding for bare ctx`, CU-wdqcq067kw)
Touches: `plugins/claude-code/{package.json,package-lock.json,bin/}` (new), `plugins/claude-code/commands/setup.md`, `plugins/shared/core/{session-start,lib}.js`, `plugins/gemini/skills/contextnest-setup/SKILL.md`, `packages/cli/src/first-run.ts` (copy only), plugin README/CHANGELOG, tests

## 1. Problem

PR #228 adds a first-run setup to the CLI. The first bare `ctx` in a terminal
asks where the vault should live (this machine, team server, both, or skip). It
then creates `~/ContextNest/main` with the `developer` starter, or signs in to
`https://nest.promptowl.ai` as `promptowl`.

The Claude Code plugin already has its own setup, `/contextnest:setup`, and the
two now disagree:

| | `ctx` first run (PR #228) | `/contextnest:setup` today |
|---|---|---|
| Recommended | On this machine | PromptOwl cloud |
| Local + server together | yes ("Both") | no |
| Local folder | `~/ContextNest/main`, alias `main` | `~/contextnest`, derived alias, "My notes" |
| Starter | `developer` | none |
| Already signed in to the server | reuses the saved key, no browser | runs `login` again |
| No browser (SSH, no display) | prints the link | the link is in Bash output the user can't see while `login` waits (up to 10 min) |
| Questions before anything happens | 1 (+1 confirm) | 3 on one screen |

A user who sets up in one place and later meets the other gets two vocabularies
and can end up with two vaults. On macOS and Windows, `~/contextnest` and
`~/ContextNest` are the same folder, so the new default would land *inside* an
old plugin-made vault.

The new onboarding also only runs in a real terminal, and the agent's Bash tool
isn't one. An agent that follows the new README ("run `ctx`") gets help text and
"Run `ctx` in a terminal to get set up.", and passes that on to the user instead
of running the plugin's setup.

Two more gaps:

- **Installing the plugin doesn't install the CLI.** The hooks fall back to
  `npx -y @promptowl/contextnest-cli`, which is slow. On a first session the
  `npx` download probably runs past the 8 s hook limit, so the overview says
  "CLI not available". This is unverified.
- **Nothing tells the user to run setup.** The no-vault hint goes into Claude's
  context only, so a user who never types `/contextnest:setup` may never learn
  it exists.

## 2. Goal

There are two ways in, and they should behave as one setup. Whether the user
types `ctx` in a terminal or uses Claude Code, they see one question in plain
words and end up with the same notes in the same place. Once either way is
finished, the other one stays quiet.

The persona test: a developer who has never heard of vaults, nests, or `ctx`
should be done in under two minutes. They are told to run setup without having
to know about it, answer one question, install nothing by hand, and never see a
word they have to look up.

## 3. Approach

The CLI flow (`runOnboarding` in `packages/cli/src/first-run.ts`) only runs two
existing commands in order: `ctx init`, then `ctx login` or `ctx vault add`. The
plugin can run the same commands with the same arguments. No new CLI command is
needed.

**Rejected for now:** a non-interactive `ctx onboard --local|--server|--both`.
It would give one code path, but it adds public CLI surface for something two
existing commands already do. Revisit it if a third agent plugin needs it.

**Drift guard:** export `DEFAULT_ALIAS` and `DEFAULT_STARTER` from `first-run.ts`.
Then add a plugin test that checks `setup.md` and the Gemini setup skill name the
same server, folder, alias, starter and `--as promptowl`.

**Words:** users see **notes** everywhere. "Vault", "nest", "alias", "starter",
"pin", "default" and "register" stay inside commands and are never shown as a
choice. Each place says where the notes go: "this computer", or the hostname.

## 4. Changes

### 4.0 The CLI comes with the plugin

Claude Code installs a plugin's npm dependencies by itself, both when the plugin
is installed and when it updates. It does this when the plugin folder has a
`package.json` and a lockfile. It runs the install with scripts disabled and a
60 s limit, using the user's npm or Bun. See
https://code.claude.com/docs/en/plugins/loading.md#node-js-package-dependencies.

The published CLI is a good fit. 3.4.0 depends on `commander` plus an optional
`chalk`, has no install scripts, and is 4.3 MB unpacked. A scripts-disabled
`npm ci` of it took about 1 s and 4.6 MB, and the installed `ctx --version` ran.

1. **`plugins/claude-code/package.json`.** Add
   `"dependencies": { "@promptowl/contextnest-cli": "<exact version>" }` and
   commit a `package-lock.json`. `plugins/` is not in the pnpm workspace, so an
   npm lockfile there clashes with nothing.
2. **`plugins/shared/core/lib.js` (`makeExec`).** Change the fallback order to:
   the configured or global `ctx`, then the bundled
   `node <plugin>/node_modules/@promptowl/contextnest-cli/dist/index.js`, then
   `npx`. Resolve the bundled path from `import.meta.url`. If it isn't there,
   which is the case for Gemini and for `--plugin-dir` dev sessions, fall
   through to `npx`.
3. **`plugins/claude-code/bin/ctx`.** Add a two-line launcher for the bundled
   CLI. Files in a plugin's `bin/` are on the Bash tool's `PATH` while the
   plugin is enabled, so Claude can type plain `ctx` with nothing installed. A
   user's own `ctx` still wins, because plugin `bin/` comes after the user's
   `PATH`. Also add `bin/ctx.cmd` if Windows needs it: the docs don't say how
   extensionless `bin/` files work on Windows.
4. **`/contextnest:setup` stops asking to install the CLI.** At the end it offers,
   once and optionally: "Want `ctx` in your own terminal too? `npm i -g
   @promptowl/contextnest-cli`". That install is the only thing that puts `ctx`
   on the user's shell `PATH`.
5. **Release.** Bump the pin and lockfile after each CLI publish. It can't be
   done in the changesets version PR, because the lockfile needs the published
   tarball's integrity hash. `plugins:check` fails if the lockfile and the pin
   disagree. The step is written into the Releasing section of `CLAUDE.md`:
   set the pin, refresh the lockfile, and bump the plugin version, because
   installed plugins only re-fetch dependencies on a new plugin version.

Rejected:
- Committing the built CLI (4.3 MB) into the plugin.
- The docs' SessionStart `npm install` into `${CLAUDE_PLUGIN_DATA}`. It is POSIX
  shell only, and it isn't needed now that the automatic install exists.

### 4.1 `/contextnest:setup` (`plugins/claude-code/commands/setup.md`)

1. **One question:** "Where should Claude keep its notes?"
   - **On this computer (recommended).** Private and works offline. Creates `~/ContextNest/main`.
   - **Online at nest.promptowl.ai.** Needs an account, and your team can share the notes. A company server URL can be typed into "Other".
   - **Both.**
   - **Not now.**

   This is always the recommended answer, as it is in the CLI. The CLI comes
   with the plugin (4.0). If even the bundled copy is missing, for example
   because the automatic install failed, offer to install it with npm, and fall
   back to the online MCP path only if that isn't possible.
2. **No usage or scope questions.** Apply **Light** (`search` / `explicit`) for
   all projects, and say at the end how to change it (`/contextnest:config`).
   The no-CLI cloud path uses `claude mcp add --scope user`.
3. **The local path matches the CLI exactly.** In `~/ContextNest/main`, run
   `ctx --yes --vault main init --starter developer --name main --tools claude`,
   adding `--set-default` only when there is no default. Then:
   - If `~/ContextNest/main` already holds a vault, add it (`ctx vault add main ~/ContextNest/main`) instead of creating one.
   - If `~/ContextNest` is itself a vault (an old plugin-made `~/contextnest` on a case-insensitive disk), don't nest a vault inside it. Ask for another folder.
   - If the name `main` is taken, ask for another name.
   - Offer a different template, name or folder only when the user asks for it in "Other".
4. **The online path reuses a sign-in and never duplicates one.**
   - If a vault already points at that server (`ctx vault list --json`), say "You're already connected to nest.promptowl.ai (N nests)" and stop.
   - If `ctx login --list --json` has a saved key for it, run `ctx vault add promptowl --url "<server>/mcp"` with no browser. Check that the nests appear, and fall back to a fresh `login` if they don't.
5. **The sign-in link is always visible.** Run `ctx login` in the background,
   read its output for the "Approve the login in your browser" link and code,
   and post them in the chat. Over SSH or with no display, set
   `CONTEXTNEST_NO_BROWSER=1`.
6. **Both:** set up this computer first, as the default. Then add the online
   notes without `--set-default`, the same order the CLI uses. If the online half
   fails, keep the local notes and say how to retry.
7. **Not now:** write `"setup": "declined"` to `~/.contextnest/plugin-settings.json`
   (section 4.2), say "OK. Run /contextnest:setup any time.", and stop. Every
   path that finishes writes `"setup": "done"`. That includes "already set up"
   and the online-MCP-only path, which leaves no `ctx` vault for the hook to see.
8. **Finish with a first real note, not a search.** A fresh developer vault holds
   only placeholder pages, so searching it "proves" nothing. `init --starter`
   already prints the starter's first-note prompt for the agent. Follow it: one
   question about what to capture first, then one real note, written only after
   the user agrees. Close in at most three lines:
   - where the notes are
   - what Claude now does on its own: it checks the notes on each prompt, and saves when you say "remember…"
   - how to change that: `/contextnest:config`
9. **Already set up:** "Claude is already using your notes (`~/ContextNest/main`)."
   The choices are: Done · Add my team's notes · Change which notes Claude uses
   first. The last one hands over to `/contextnest:config vault`, and its picker
   reads "Which notes should Claude use first? [each] · Ask me each time".
10. **Fewer approval prompts.** Add `allowed-tools` to the command's frontmatter
    for the read-only probes and the setup commands:
    - `ctx --version`, `ctx vault list`, `ctx login --list`
    - `ctx init`, `ctx login`, `ctx vault add`

    The optional global `npm i -g` still asks, because it changes the user's machine outside the plugin.
11. **Rename the frontmatter** to match: the `description` and `argument-hint`
    (`[local|online|both] [server-url]`; `cloud` stays accepted as an alias for
    `online`).

Unchanged:
- the no-CLI cloud path over MCP (it is now a fallback, not the recommended path)
- "never replace an existing setup"
- the reassurance, reworded to "Nothing leaves this computer unless you choose to put it online." (it no longer mentions `ctx push`)

### 4.2 Session overview (`plugins/shared/core/session-start.js`, `lib.js`)

- **Tell the user to run setup if they haven't.** The hint below reaches only
  Claude. The user also needs to see it.
  - When there is no registered vault, no working-directory vault, no
    `CONTEXTNEST_VAULT` or `CONTEXTNEST_VAULT_PATH` (the same "existing user"
    test as the CLI's `shouldOnboard`; `cwdVault` ignores an env-var vault), and no
    `setup` key, the SessionStart hook also returns a `systemMessage`, which the
    docs describe as a message shown to the user: "Context Nest isn't set up
    yet. Run /contextnest:setup to give Claude a notes folder. It takes about a
    minute."
  - It fires only when the hook input has `source: "startup"`, not on resume,
    clear or compact. So the user sees it once per new session, before they
    type anything, and never in the middle of a task.
  - It stops once setup writes `done` or `declined` (4.1 item 7), or once a vault
    exists, including one made by bare `ctx` in a terminal.
  - Users who set up 0.7.0 over MCP only have no vault and no key, so they see
    it once per session until they re-run setup. Setup then answers "already
    set up" and writes `done`.
  - To verify: the docs list the events that drop `systemMessage` (Setup,
    InstructionsLoaded, Notification), and SessionStart is not among them. Check
    it in a real session before relying on it. `initialUserMessage` can't start
    setup by itself, because it works only in `-p` mode.
- **Warn when the user's own `ctx` is older than the plugin's.** The plugin
  always runs the user's global `ctx` first (4.0), so an old one silently
  costs features. For example, `login` arrived in 3.2.0, and `structure
  --json` returns an error on older CLIs.
  - Only on `source: "startup"`, SessionStart runs one extra `exec(["--version"])`.
    It goes through the same fallback, so it reports whichever CLI the hooks
    actually use. It costs one CLI start, about 0.2–0.4 s, once per new
    session.
  - The IO shell reads the CLI pin from the plugin's `package.json` and passes
    it to `run()`. Gemini has no pin, so it skips the check.
  - If the reported `x.y.z` is lower than the pin, return a `systemMessage`:
    "Your `ctx` is 3.1.0; this plugin expects 3.4.0 or newer. Update it with
    `npm i -g @promptowl/contextnest-cli@latest`."
  - When the bundled or `npx` CLI answered, the version is equal or newer, so
    there's no message.
  - Unparseable output, a failed call, or `CONTEXTNEST_NO_HINTS` all mean no
    message.
  - It joins the setup message in one `systemMessage` if both apply.
  - Not chosen: preferring the bundled CLI over an older global one. That
    would need a version check in every hook process (one per prompt), or a
    cached decision.
- Rewrite `SETUP_HINT`:
  - Mention setup once per session, in one line, and never in the middle of the user's task.
  - If the user asks to set up, run `/contextnest:setup` yourself, and recommend this computer.
  - Never send them to a terminal and never run bare `ctx` to set up, since it needs an interactive terminal.
- If `getConfig` reads `setup: "declined"` from the settings files, the overview
  says only "Context Nest isn't set up (the user chose not now). Run
  /contextnest:setup only if they ask." Add the key to the config projection.
- A terminal "Skip" (`skipped_at`) is **not** treated as declined. Installing the
  plugin shows new intent, so it is offered once. This needs no CLI change.
- Then run `pnpm plugins:sync`.

### 4.3 Gemini setup skill (`plugins/gemini/skills/contextnest-setup/SKILL.md`)

Make the same changes as in 4.1, with `--tools gemini` and a numbered
one-message question in place of the picker. While there, make Light consistent
with Claude Code (`explicit`, not `off`).

### 4.4 CLI copy (`packages/cli/src/first-run.ts`, strings only)

The persona found the terminal flow uses the jargon that the plugin is dropping.
This is the same vocabulary, in the other way in. Land it in PR #228 if it is
still open; otherwise make it the first commit of this ticket.

- Banner question: "Where should Claude and your other AI tools keep their notes?" Labels as in 4.1 item 1, with "Skip: just show me the commands".
- Skip text and `NO_VAULT_LINE`: "`ctx init` makes a private notes folder on this computer. `ctx login https://nest.promptowl.ai` puts them online." Drop the `vault add <alias>` line for first-timers.
- Local confirm: "Create your notes in ~/ContextNest/main (pre-filled pages for a software project)? [Y/n/customize]".
- Ending, when Claude Code is detected: replace "`ctx init` wrote CLAUDE.md / agent config into the vault" with "Using Claude Code? Add the Context Nest plugin and it finds these notes by itself." Show the two install commands from the README.
- Update the unit test assertions that match the old strings.

### 4.5 Docs and release

- `plugins/claude-code/README.md`:
  - Setup section: running `ctx` in a terminal and `/contextnest:setup` are the same setup and end up in the same place, with one question.
  - Requirements section: the CLI comes with the plugin. `npm i -g` is needed only for `ctx` in your own terminal.
- Bump the plugin from `0.7.0` to `0.8.0` and add a CHANGELOG entry. Add a CLI changeset if 4.4 doesn't ride in PR #228.

### 4.6 Tests

- `plugins/__tests__/core.unit.test.ts`:
  - the no-vault overview contains the new hint and never suggests bare `ctx`
  - `setup: "declined"` gives the one quiet line
  - a terminal `skipped_at` alone still offers setup
  - `systemMessage` appears only on `startup` with nothing set up, and never after `done`, `declined`, or once a vault exists, or with `CONTEXTNEST_VAULT_PATH` set
  - Outdated `ctx`: a fake `--version` of `3.1.0` against pin `3.4.0` gives the update line; equal, newer, unparseable, failed, no pin, or a non-startup `source` gives none; both messages join into one
- `plugins/__tests__/io-shell.test.ts`: when `ctx` gives ENOENT, `makeExec` tries the bundled CLI before `npx`.
- `plugins:check`: the plugin's pinned CLI version matches its lockfile.
- A new drift test (section 3).
- `packages/cli/src/__tests__/first-run.test.ts`: updated strings.
- No new tests are needed for `init`, `login` or `vault add`, because they already have tests.

## 5. Out of scope

- A non-interactive `ctx onboard` command (section 3).
- Writing `onboarded_at` or `skipped_at` from the plugin. Once the plugin makes a vault, the next bare `ctx` already treats the user as an existing user and marks them silently.
- Changing `ctx login` itself (the copy-code screen, a nest picker), which PR #228 also leaves out.
- Codex, whose plugin is README-only.

## 6. Risks

- The automatic dependency install is documented for marketplace installs, which
  copy the plugin into a cache. `--plugin-dir` dev sessions load in place, so
  they probably skip it (inferred) and fall back to `npx` or a manual `npm ci`.
  The install also needs npm or Bun on the user's `PATH`. The hooks already need
  Node, so in practice this adds nothing.
- If the user's own global `ctx` is older than the bundled one, it still wins.
  The user is told once per session how to update it (4.2), but until they do,
  the hooks run with the older CLI's features.

- The model has to read the sign-in link from a background `ctx login`. If the link line changes, setup silently waits. The drift test should also match the "Approve the login in your browser" line in `index.ts`.
- `allowed-tools` pre-approves `ctx init`, `ctx login` and `ctx vault add` only while the command runs. Never add `ctx delete`, `ctx forget` or a bare `ctx:*` wildcard.
- The starter's first-note prompt is written to make the agent act at once. Setup must keep its own rule above it: ask first, and write one note only after the user agrees.

## 7. Steps to test

1. Use a clean profile: run `export CONTEXTNEST_CONFIG_DIR=$(mktemp -d)` with an empty `HOME`, install the plugin, and start Claude Code in any code repo.
2. Before typing anything, you should see "Context Nest isn't set up yet. Run /contextnest:setup…". Ask Claude to run `ctx --version`; it should work with no global install.
3. Run `/contextnest:setup` and accept the recommendation. You should see one question and no install prompt. Then `~/ContextNest/main` is created, Claude asks what to capture first, and the reply ends with three short lines. Start a new session: there should be no setup message.
4. Install the CLI globally (`npm i -g @promptowl/contextnest-cli`), then run `ctx` in a terminal. You should see plain help with no setup menu, and exit code 0.
5. Reset. Run `ctx` in a terminal first and press Enter twice; the wording should match step 3. Then start Claude Code. You should see no setup message. Run `/contextnest:setup`: you should see "Claude is already using your notes (~/ContextNest/main)" and no second vault.
6. Reset. Run `/contextnest:setup` and choose **Online**. The approval link should appear in the chat, and after you approve, the nests are listed.
7. Repeat step 6 while already signed in. No browser should open, and the nests connect straight away. Run it once more: you should see "already connected", and nothing is added twice.
8. Choose **Both**. Your local notes should be the default, with the online nests beside them.
9. Choose **Not now**, then start a new session. You should see no setup message, and Claude should not offer setup unless you ask.
10. With no vault, type "set up context nest for me". Claude should run the setup itself and recommend this computer. It should never tell you to open a terminal.
11. Resume a session (`claude --resume`) with nothing set up. The setup message should not repeat.
12. An existing user: a global `ctx` with a registered vault (or only `CONTEXTNEST_VAULT_PATH` set), then install the plugin. You should see no setup message, `which ctx` in Claude's Bash should show the global one, and the overview should list your existing vaults.
13. Same as step 12, but with an older global CLI (`npm i -g @promptowl/contextnest-cli@3.1.0`). At session start you should see "Your `ctx` is 3.1.0; this plugin expects 3.4.0 or newer…". Update it and start a new session; the line should be gone.

## 8. Persona review (summary)

A subagent played Priya, a developer new to Context Nest who skims and distrusts
uploads, and Sam, who uses the hosted server, through five scenarios against the
first draft. Verdict: **ship, with changes**. Every change below is in section 4:

- Always recommend this computer. The draft recommended the hosted server whenever `ctx` was missing, which sent a newcomer to an account sign-in.
- Use "notes" instead of vault, nest, template, alias, pin and default, in both the terminal and the plugin.
- Cut the usage and scope questions, leaving one question. (The install approval it left has since gone too, because the CLI now comes with the plugin, 4.0.)
- Don't "prove it works" by searching placeholder template pages. Write a first real note instead.
- Don't register an already-connected server twice, and reword the "already set up" screen.
- Remember "Not now" across sessions. Don't treat a terminal Skip as a permanent no.
- Add `allowed-tools` so setup isn't a string of approval prompts.
