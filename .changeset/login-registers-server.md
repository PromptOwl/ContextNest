---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**`ctx login <server>` now registers the server, so its nests are usable straight away.**

- A server-wide login adds a remote to your vaults, marked `scope: server` in `~/.contextnest/config.yaml`. It holds no key (the alias borrows the one in the secure store) and never takes your default vault unless it is your first entry. Its nests show as `<alias>/<nest>` in `ctx vault list`; address one with `--vault <alias>/<nest>`, or read across all of them with `--vault <alias>`. The alias comes from the host (`nest.promptowl.ai` → `promptowl`) or `--as`; `--no-register` keeps the old key-only behaviour; a `--nest` login registers nothing.
- **Already logged in?** A person at a terminal now sees one line on stderr on every command, until the server is registered (`ctx vault add <alias> --url <server>/mcp`) or hints are off (`ctx hints off`, or `CONTEXTNEST_NO_HINTS=1`). Agents, CI, pipes and `--json` never see it. `ctx doctor` and `ctx login --list [--json]` show which login each alias uses, and the Claude Code plugin mentions an unregistered login at session start.
- **Re-authenticating:** auth errors now carry the exact command (`ctx login https://… [--account x]`) instead of `<server>`. `ctx login <alias>` signs in again for a registered alias. At a terminal, a rejected key offers to sign in on the spot and then runs the command you asked for.
- New: `ctx vault rename <old> <new>`; `vault list` shows `[server]` / `[nest]`, and a rejected key reads "key rejected" while an unreachable server reads "not answering". The registry's optional `scope` is ignored by older versions, so mixed installs keep working.
- Migration: if you logged in before this release, run `ctx login <server>` once (or the `ctx vault add` command the hint prints).
