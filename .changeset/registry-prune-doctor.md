---
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-engine": patch
---

Registry hygiene and `ctx doctor`.

A real registry was found with its default pointing at a deleted `/tmp` scratchpad and four of nine aliases `[missing]`: `ctx init` auto-registered every vault it created, including the throwaway ones agents and test runs make under the OS temp dir, and nothing could clean them up short of editing `config.yaml` by hand. Separately, the installed CLI sat two minors behind npm and the Claude Code plugin one behind its release for months, unnoticed, and `ctx init --help` listed five starters while `--list-starters` had six.

- `ctx vault prune [--dry-run] [-y]` removes local aliases whose vault is no longer on disk (directory gone, or `.context/config.yaml` gone — the same rule `vault list` marks `[missing]`). Remotes are never touched. If the default was among them it is cleared and the command says so. Destructive: refuses without `--yes` when there is no TTY, and `--dry-run` previews against a throwaway copy of the registry. Engine: new `pruneVaults()`.
- `ctx init` no longer registers a vault whose root is under `os.tmpdir()` (realpath on both sides). It prints `Not registering: vault is under the temp dir (pass --register to force)`; `--register`, or an explicit `--vault <alias>` / `--set-default`, registers anyway. Outside the temp dir nothing changes.
- `ctx vault list` prints `default vault is missing — run ctx vault prune` when the default alias points at a missing vault.
- `ctx init --help` generates the `--starter` list from the starter registry, so it cannot drift from `--list-starters` again.
- `ctx doctor [--json]` reports the CLI version, the bundled engine version (new `ENGINE_VERSION` export, baked in at build time), the latest published CLI version from `npm view` (3s timeout; offline or `CONTEXTNEST_DOCTOR_OFFLINE=1` → `null`, never an error), registry health (path, counts, missing aliases, whether the default is missing), whether the current directory is inside a vault and under which alias, and the installed Claude Code plugin version from `installed_plugins.json` (honours `CLAUDE_CONFIG_DIR`). Always exits 0.
