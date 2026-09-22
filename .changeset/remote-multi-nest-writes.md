---
"@promptowl/contextnest-cli": minor
---

Remote nests take the same edits a local vault does, on every nest you have registered.

- **`ctx update --tags` and `--status` work against a remote nest.** Only `--body` did before. Tags replace the set, as they do locally. `--title` is still refused remotely: a Community nest reads `title` as the node selector, so a rename would be silently ignored.
- **New `ctx move <path> <folder> --vault <alias>`** refiles a document on a remote Community nest (its id changes; history and links follow). A local vault has no move operation yet, so it refuses there.
