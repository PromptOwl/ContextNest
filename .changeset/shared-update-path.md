---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

`context_update` becomes the shared update path for every surface

The operation could not rename a node, could not set a status, and always
published — so no surface could adopt it, and the CLI, MCP server and Community
each kept a private copy of "edit a document". The copies drifted, and one rule
in particular ("a lifecycle status change is metadata, not a release") was
hand-rolled identically in two places and absent from a third.

`context_update` now accepts:

- `title` as the **new** title. It was previously a way to *select* the node to
  update — but every surface addresses a node by id or path and sends a title
  only to rename, so selecting by title served no caller and collided with the
  field they all wanted. Selection is by `id`.
- `status` — a canonical lifecycle status (normalize aliases with
  `normalizeStatus` before calling).
- `publish` — defaults to true, and to **false** when `status` names a
  non-published lifecycle value, because those are metadata transitions rather
  than content releases. An explicit value always wins. This is the rule the CLI
  and MCP server each carried privately.
- `note` — recorded against the publish in version history.
- `version` — an explicit version to stamp, for governed callers that assign
  version numbers themselves for a revision awaiting review. Ignored when
  publishing, which assigns its own.

Output gains `status` and `checkpoint`, mirroring `context_create`.

Three behaviour changes come with it:

- **`tags` replaces rather than merges**, matching the CLI, the MCP server and
  `context_create`. A caller that wants the old merge sends the merged set.
- **`metadata` treats a null value as "clear this key".** A merge alone gave
  callers no way to remove metadata at all: over a JSON wire an absent key is
  indistinguishable from "leave this alone".
- **A rejected document is refused only when no `status` is given.** Naming a new
  status is how a caller revives one, which the MCP server already allowed and
  the operation previously blocked outright.
- **A body edit drops the stored checksum before writing.** The checksum
  describes the published body, so an edit whose publish then fails used to
  leave a stale one on disk and the next verified read reported the document as
  externally modified. Frontmatter-only edits keep it — the checksum covers the
  body alone.

**Bug fix — updating a flat-layout vault.** The operation re-rooted a bare
document id under `nodes/`, which silently redirected every id from a vault whose
documents don't carry that prefix. Ids are now vetted for traversal without being
rewritten, and the storage layer resolves them for its own layout — the same fix
`context_import` took for its `ids` input.

`ctx update` and a new `context_update` MCP tool both run through that one path.
`update_document` keeps its exact behaviour and registration (including its status
aliases) and is now marked deprecated in favour of `context_update`, so existing
MCP clients are unaffected.
