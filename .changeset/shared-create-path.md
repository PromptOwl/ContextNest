---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

`context_create` becomes the shared create path for every surface

The operation could only derive an id from title + folder, always published, and
could not express a skill block — so no surface could actually adopt it, and the
CLI and MCP server each kept a private copy of "create a document". Those copies
drifted: the same action produced different version numbers depending on which
one you used.

`context_create` now accepts:

- `id` — mint your own instead of deriving from title + folder.
- `publish: false` — leave the node a draft, for governed callers whose writes
  must clear review before becoming retrievable.
- `note` — recorded against the publish in version history.
- the `skill` block fields (`trigger`, `inputs`, `tools_required`,
  `output_format`, `guard_rails`), without which the operation could not produce
  a valid `type: skill` node at all.

Output gains `status` and `checkpoint`, and a created node now carries
`updated_at` instead of rendering blank until its first edit.

`ctx add` and a new `context_create` MCP tool both run through that one path.
Surface-specific authoring niceties — heading and step templates, default skill
triggers — stay with their surface. `create_document` keeps its exact behaviour
and registration and is now marked deprecated in favour of `context_create`, so
existing MCP clients are unaffected.

**Behaviour fix — new-document version numbering.** `ctx add` wrote
`version: 1` into frontmatter and let publish bump it, so a brand-new document's
history began at **v2 with no v1 keyframe**. Publish owns version assignment
(spec §6); a newly created document is now v1. The MCP server already had this
fix, the CLI did not. Existing documents are unaffected.
