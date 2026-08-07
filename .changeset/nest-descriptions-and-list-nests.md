---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

Nests carry a description, and agents can list every registered nest

An agent targeting a nest had only its alias to go on. Nests now carry a
human-readable description that says what the nest is *for*, and there is an
operation to enumerate them.

- `context_nests` lists every nest in the central registry:
  `{}` → `{ nests: [{ alias, path, description?, isDefault, exists }] }`. It is
  the first **registry-scoped** operation in the catalog — it reads
  `~/.contextnest/config.yaml` rather than one vault, so it ignores its
  `OperationContext`. The MCP server exposes it as a catalog-driven tool.
- `NestStorage.init()` takes an optional `description` and writes it into
  `.context/config.yaml` (spec §11.1), so `ctx init --description` now reaches
  the nest's own config and not just the registry entry. `ctx init` resolves its
  interactive description prompt before creating the vault, so a prompted value
  lands in the config too.
- `setVaultDescription(alias, description?)` and `ctx vault describe <alias>
  [description]` edit a registry description after the fact. Omitting the text
  (or passing blank) removes the key rather than storing `""`, so the nest's own
  config description takes over again.

**Description precedence**, applied wherever nest metadata is surfaced: the
registry entry's `description` (a machine-local label for *your* alias), then
the nest's own `.context/config.yaml` `description` (travels with the vault),
then its `name`. Blank counts as unset at every tier.

**Behavior change (`ctx vault list`):** `listVaults()` previously fell back to
the config's `name`, skipping its `description` entirely. Vaults whose config
carries a `description` now show it instead of their `name`.
