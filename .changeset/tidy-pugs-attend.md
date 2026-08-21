---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
---

Add `client` — caller metadata on every read and write in the operation catalog

Every `core` operation now accepts an optional `client` object naming the
calling agent and its session, plus any custom scalar keys:

```jsonc
{ "title": "API Design", "content": "…",
  "client": { "agent": "claude-code", "session_id": "s-9f2" } }
```

A write that publishes records it on the version-history entry it seals, so
`context_versions` answers "which agent wrote v7, in which session"; a graph
read stamps it on the §9.2 access traces it emits; every other operation hands
it to extension `authorize` / `onResult` hooks. The MCP tool surface picks it up
automatically — its schemas come from the catalog.

`client` is a label, not an identity claim: it is never authenticated, never
used to authorize, and deliberately not an input to any hash chain, so histories
recorded before the field existed keep verifying byte-for-byte. It is bounded
(scalar values ≤ 512 chars, ≤ 16 custom keys) because it lands in an append-only
audit trail. It is distinct from the `metadata` argument, which is frontmatter
and describes the document rather than the call.

Specified in `CONTEXT_NEST_SPEC.md` §9.4, with the `client` field on version
entries added to §6.2.
