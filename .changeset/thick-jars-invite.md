---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

Vault-hosted skills: install a `type: skill` node into an agent harness

A skill node can now be rendered as a Claude Code `SKILL.md`, a Cursor rule, a
Codex skill, or raw markdown, and installed into the caller's project or home
directory. `skill.trigger` becomes the harness's local matcher — the one field
that must exist locally, since matching happens before anything can be fetched,
so a skill node without a trigger is refused rather than given a guessed one.

The default install writes a **loader**: the trigger plus an instruction to fetch
the procedure from the vault at runtime. A loader cannot go stale because it
never holds a copy. `mode: "full"` embeds an offline snapshot instead, and says
out loud that the copy will drift.

- New engine module `skills.ts` (`renderSkill`, `buildInstallManifest`).
- New catalog operations `context_skill` and `context_skill_install`, which the
  MCP server registers automatically — 38 tools now.
- New CLI commands `ctx skill <path>` and `ctx skill install <path> [--write]`.
  Writes land outside the vault, so they go through the same never-clobber guard
  and dry-run accounting as `ctx read --out`.
- New `skills.bootstrap` key in `.context/config.yaml`, naming the skill that
  teaches an agent to use this vault. `context_init` returns it as
  `config.skill_bootstrap`.
- Node bodies can write `{{server_alias}}` / `{{vault_id}}` / `{{node_path}}`
  instead of hardcoding an `mcp__…__` prefix that is only correct on one client.
