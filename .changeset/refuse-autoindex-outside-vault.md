---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

Refuse to auto-index or read a directory that is not a vault.

When nothing else resolved a vault (no `--vault`, no env override, no local vault above cwd, no registry default), `ctx` fell through to the bare working directory and treated it as one: `ctx query "#x"` in a plain folder printed "No context.yaml found. Auto-indexing vault..." and wrote a `context.yaml` there, and `ctx list` then reported every `.md` under the folder as a draft document. From `$HOME`, `ctx search` crashed on an unrelated YAML file.

- The CLI and the MCP server now refuse that bare-cwd fallback (via one shared engine helper, `assertVaultRoot`) unless the directory is a real vault root (`.context/config.yaml`; a bare `context.yaml` left behind by the old bug does not count). The CLI prints `Error [NO_VAULT]: <dir> is not a Context Nest vault. Run "ctx init" here, or pass --vault <alias> (registered: a, b, c).` — exit 1, nothing written. The check lives in the shared vault-resolution helper, so every read command (`query`, `resolve`, `search`, `list`, `read`, `info`, `verify`, `validate`, `history`, `pack list`, `checkpoint list`, …) and, for free, the vault write commands (`add`, `update`, `index`, …) are covered. `ctx init` and the `ctx vault *` registry commands are exempt. `contextnest-mcp` started from a non-vault directory with nothing else resolving prints the same message and exits non-zero instead of serving the directory. The other resolution steps are unchanged: a local vault above cwd and a registry default still resolve as before.
- New `NoVaultError` (code `NO_VAULT`) in the engine, following the existing error-class pattern.
- `GraphQueryEngine.query()` only auto-generates a missing `context.yaml` when the storage root is a real vault (`.context/config.yaml` present). A real vault whose `context.yaml` was deleted still regenerates it on the next query.
