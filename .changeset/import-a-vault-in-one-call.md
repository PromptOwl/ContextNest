---
"@promptowl/contextnest-engine": minor
---

Give `context_import` the whole folder-import flow, instead of half of it.

Importing an existing vault took two passes over every document before
publishing even started. The importer scanned the vault itself, rewrote each
file to stamp its own metadata (an `author` that is the importing user, a title
falling back to the filename), and only then handed the ids back to be
published — which rewrites each file again. On a network-backed mount that is
two extra round trips per document, and the scan is duplicated work the engine
had already done.

Three additions close that gap:

- `files[]` writes an existing vault's files in **verbatim**, at their own
  relative paths. Nothing is synthesized, so the source's frontmatter survives
  (`version`, `checksum`, custom keys a generated draft would drop), and files
  that are not documents travel too — `.versions/<doc>/history.yaml` included,
  which is what lets an imported version chain still reconstruct. Paths are
  guarded: `..` and absolute paths are rejected per-file rather than aborting
  the import.
- `publish: false` stages files without publishing them. An upload that arrives
  in several batches can stage every batch and publish once at the end, so the
  import seals ONE checkpoint rather than one per batch.
- `discover: true` makes the vault itself the input. The engine scans, decides
  publish-vs-hold from each file's own frontmatter, publishes the batch under a
  single checkpoint, and returns a record per document (`id`, `title`,
  `version`, `status`, `tags`, `content`) — enough for a governance layer to
  record the import without re-reading the vault. `exclude_ids` skips what an
  earlier run already took, so a re-import is idempotent.

The metadata stamp now rides along with the publish write through a new
`frontmatter` hook on `publishDocuments`, so it costs no pass of its own.

Two supporting pieces:

- `parser.explicitStatus(node)` returns the status the author actually wrote, or
  `null`. `parseDocument` defaults a missing `status` to `draft`, so
  `frontmatter.status` cannot tell a deliberate draft from a status-less
  hand-authored note. Import needs that distinction: a status-less file is fair
  game to publish, an explicit `draft` or `pending_review` must stay
  unpublished. Aliases are normalized first, so an import cannot slip a
  not-yet-approved document past the hold by spelling its status differently.
- `storage.writeVaultFile(relPath, content)` writes a file into the vault
  verbatim under a path-traversal guard, parsing nothing.
