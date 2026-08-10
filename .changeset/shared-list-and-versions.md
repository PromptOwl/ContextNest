---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

`context_list`, `context_get` and `context_versions` become the shared browse path

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

**An operation whose input carried a `.refine()` could not be exposed over MCP at
all.** A refine makes the input a `ZodEffects`, which has no `.shape` — and that
shape is exactly what a tool is registered from. The SDK accepted the undefined
value and published a tool advertising **no parameters**, so a client had no way
to know what to send; `context_versions` shipped that way. The selector schemas
are plain objects now and `resolveId` raises the same `VALIDATION_FAILED` at
execution time. A regression test asserts each catalog tool advertises its
declared inputs, which the old "inputSchema is defined" check sailed past.

**Reading a node from a flat-layout vault returned NOT_FOUND.** `resolveId`
re-rooted a bare id under `nodes/`, so every id from a vault whose documents
carry no such prefix pointed at a document that does not exist — the same fix
`context_update` and `context_import` already took, now applied to every
selector-based operation.

An id is therefore taken **exactly as stored**: a bare slug is no longer
re-rooted under `nodes/`, so a caller migrating from `read_document` (which did
re-root) must pass the full id. A trailing `.md` and leading slashes are still
stripped, since callers build ids from file paths and storage appends `.md`
itself.

`context_get` gains three inputs, each one a thing a surface previously had to
bypass the operation to do: `include_raw` returns the exact stored bytes for
callers that re-serve the file verbatim, `verify_checksum` detects drift on read,
and `allow_rejected` returns a retired node instead of refusing — reading one is
not the same as republishing it. It is registered as an MCP tool, with
`read_document` deprecated in its favour.

`ctx read` runs through it. `ctx list` gains `--limit` and now runs through the
operation. `ctx history` runs
through `context_versions` and gains `--diff`, which it could not do at all
before. Both `context_list` and `context_versions` are registered as MCP tools;
`list_documents` keeps its exact behaviour and is marked deprecated in favour of
`context_list`. `context_versions` is a new capability there — nothing exposed
version history before, since `read_version` answers a different question.
