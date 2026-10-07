---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
---

Add the `view` node type (spec §1.12): a governed composition of other nodes. A view's required `view` frontmatter block is a layout of blocks (`md`, `list`, `summary`, `html`, `table`, `kpi`, `chart`, `callout`, `metric`, `data`) that name what to show and where it comes from. Being frontmatter, the layout is versioned and hashed like any node, so approving a view approves its layout.

- **Validation (rules 30–35, §13.5):** the block is required on `type: view` and forbidden elsewhere, needs at least one block with exactly one kind each, and is strict at every level. Every `ref`/`binding` must be a node path or `contextnest://` URI, never a URL, so no URL, credential or unknown key can ride inside a view. Selectors must parse, and `from`/`data_from` must name an earlier block's id.
- **Writes:** `context_create`, `context_update`, `context_import` and the MCP `create_document`/`update_document` tools take a `view` parameter. A node can be created as a view or re-typed to and from one in a single call, as with `source` and `skill`.
- **Resolution:** new `resolveView(node, { documents, reconstructVersion?, includeDrafts? })` resolves `md`, `list` and `callout` blocks from the vault under retrieval visibility (published only by default; forgotten nodes never resolve). It returns a structured result, a markdown rendering and what a render receipt needs: each `md` block's `ref@version` and content hash, each `list` block's members and set hash, and `viewFingerprint(view)` over the layout. Other kinds come back as `status: "server"` for the serving implementation.

This only widens the vocabulary, so no existing document changes bytes or hashes. §13 rule 6 now counts 15 node types (it said 13).
