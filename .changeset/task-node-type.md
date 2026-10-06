---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
---

Add `task` to `NODE_TYPES`: a unit of work on a project board. The body is markdown, and board fields (`assignee`, `due`, `priority`, `parent`) are ordinary `metadata` keys. There are no type-specific validation rules (it validates like `document`), and whether a task goes through review is up to the server's governance. This only widens the vocabulary, so no existing document changes bytes or hashes. Spec §1.6 and the MCP `frontmatter_fields.type` enum list it.
