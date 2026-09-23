---
"@promptowl/contextnest-cli": minor
---

Remote nests take the same edits a local vault does, on every nest you have registered.

- **`ctx update --tags` and `--status` work against a remote nest.** Only `--body` did before. Tags replace the set, as they do locally. `--title` is still refused remotely: a Community nest reads `title` as the node selector, so a rename would be silently ignored.
- **New `ctx move <path> <folder> --vault <alias>`** refiles a document on a remote Community nest (its id changes; history and links follow). A local vault has no move operation yet, so it refuses there.
- **One registration covers every nest on a Community server.** Register the server's all-nests endpoint once (`ctx vault add contextnest --url <server>/mcp --bearer-env …`), then:
  - `ctx vault list` shows a `contextnest/<nest>` row for each nest the key can reach, with that nest's description. The list is asked for live and cached for 5 minutes, so a newly shared nest appears without registering anything.
  - `--vault contextnest/<nest>` targets one nest for any remote-capable command (read, list, search, query, add, update, move, delete, history). `<nest>` is the listed label, the nest id, or its name.
  - `--vault contextnest` with no nest runs list/search/query across every nest. Each hit carries `vault: "contextnest/<nest>"` in `--json` output, and the human output prefixes it, so a hit can be cited and edited.
  - A write through the bare server alias says to name a nest, instead of surfacing the server's argument-validation error.
