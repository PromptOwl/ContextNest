---
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-engine": patch
---

**`ctx read` and the other commands that act on an existing document find a node at the root of an Obsidian (flat) vault.** `read`, `publish`, `history`, `reconstruct`, `update`, `delete`, `forget` and `forget-log` put `nodes/` in front of every id without a folder, so `ctx read my-node` looked for `nodes/my-node` and failed with `DOCUMENT_NOT_FOUND` for every node in a flat vault. They now send the id as typed (a `contextnest://` URI is reduced to its path, `.md` and a leading `/` are dropped) and let the engine resolve it for the vault's layout: the root-level node when there is one, else `nodes/<id>`. Against a remote nest the same commands, plus `move` and task `log`, retry a bare id once under `nodes/` when the nest answers `DOCUMENT_NOT_FOUND`, so nests that do not resolve a bare id themselves keep working. A `nodes/<id>` document that will not parse is still the one a bare id names, so the command reports why rather than a not-found.
