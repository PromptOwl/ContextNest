---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

`context_import` publishes documents already in the vault, and reports progress

Folder importers write files into the vault themselves — the file's path *is*
its document id, and its frontmatter is already authored. Until now
`context_import` could only create nodes from `title` + `content`, minting a new
`nodes/<folder>/<slug>` id for each, so those importers fell back to looping
`publishDocument` one document at a time. That loop is O(N²): every publish
seals its own checkpoint, and every checkpoint re-scans the entire vault.

`context_import` now takes an optional `ids` array alongside `documents`. Ids are
published as-is, with paths and frontmatter untouched. Both modes feed one
`publishDocuments` call, so a mixed batch still seals ONE checkpoint and
regenerates the index ONCE.

- `BulkPublishOptions.onProgress(done, total)` fires as each document settles,
  published or failed.
- `OperationContext.onProgress` carries that sink to any operation. It lives on
  the context rather than in an operation's input because inputs must stay
  JSON-serializable for the MCP/REST wire; in-process callers supply it, wire
  transports leave it undefined.
- `ctx publish --all` bulk-publishes every unpublished document in the vault
  through the operation, with a live counter.
- The MCP server exposes `context_import` as its first catalog-driven tool —
  description and schema come from the engine descriptor, so the surface cannot
  drift from the CLI and Community ones.

**Breaking (`context_import` output):** `created` is renamed to `published`, and
`checkpoint` is added. `failed` entries now carry `id` (for the `ids` path) *or*
`title` (for the `documents` path) instead of `title` unconditionally. The
operation catalog shipped in 1.3.0 with no consumers on any surface, so nothing
in-tree depended on the old shape.
