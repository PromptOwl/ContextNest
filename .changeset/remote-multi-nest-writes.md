---
"@promptowl/contextnest-cli": minor
---

Remote nests take the same edits a local vault does, on every nest you have registered.

- **`ctx update --tags` and `--status` work against a remote nest.** Only `--body` did before. Tags replace the set, as they do locally. `--title` is still refused remotely: a Community nest reads `title` as the node selector, so a rename would be silently ignored.
- **New `ctx move <path> <folder> --vault <alias>`** refiles a document on a remote Community nest (its id changes; history and links follow). A local vault has no move operation yet, so it refuses there.
- **New `ctx vault fix [alias]`** repairs a registry that points `ctx` at a Community server's all-nests `/mcp` endpoint, where every write failed (`ctx` sends no `nest` argument). It asks that server for the nests the key can reach (`nest_index`), registers each one under its own URL (`<server>/nests/<id>/mcp`, same auth, alias = slugged nest name), skips nests already registered, and removes the server-level alias. If that alias was the default, the server's first-listed nest becomes the default. Local vaults and per-nest remotes are left alone. Supports `--dry-run`.
