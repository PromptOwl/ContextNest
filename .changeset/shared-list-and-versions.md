---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

`context_list` and `context_versions` become the shared browse path

The CLI, the MCP server and Community each grew a private copy of "filter a
document list", and each got a different subset of the rules right. The filter
now lives in one place — a new exported `filterDocuments(docs, filters)` — which
`context_list` wraps and which surfaces that filter a list they already hold can
call directly.

**Two bugs in `context_list`, both of which made a filter silently return
nothing:**

- `status: "rejected"` could never match. The executor discovered documents
  without `includeRetired`, so retired ones were dropped before the status
  filter ever saw them. The CLI and MCP server each worked around this
  privately.
- `type` compared `frontmatter.type` literally, with no `document` default. The
  field is optional, so `type: "document"` skipped every document that omits it
  — which is most of them.

Also fixed, and previously inconsistent between surfaces: a tag now matches with
or without its leading `#` and regardless of case. Comparing a bare filter value
against `#`-prefixed frontmatter tags is a filter that always returns empty,
which is worse than one that errors.

`context_list` additionally accepts an **array of types**, so a caller browsing a
family of types (every runnable type, say) no longer has to list everything and
re-filter. Two more inputs let a governed surface adopt the operation rather than
keep its own copy of discovery:

- `include_retired` keeps retired nodes when no status filter is given. There a
  rejected document is still something its stewards act on, not one removed from
  the vault.
- `full` returns each node's whole frontmatter and body instead of a summary, for
  callers that go on to gate and render the documents and would otherwise have to
  read every file a second time.

`ctx list` gains `--limit` and now runs through the operation. `ctx history` runs
through `context_versions` and gains `--diff`, which it could not do at all
before. Both `context_list` and `context_versions` are registered as MCP tools;
`list_documents` keeps its exact behaviour and is marked deprecated in favour of
`context_list`. `context_versions` is a new capability there — nothing exposed
version history before, since `read_version` answers a different question.
