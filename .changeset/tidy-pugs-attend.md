---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

Add `client` — caller attribution on every read and write

Every `core` operation now accepts an optional `client` object naming the
calling agent and its session, plus any custom scalar keys:

```jsonc
{ "title": "API Design", "content": "…",
  "client": { "agent": "claude-code", "session_id": "s-9f2" } }
```

A write that publishes records it on the version-history entry it seals, so
`context_versions` answers "which agent wrote v7, in which session"; a graph
read stamps it on the §9.2 access traces it emits; every other operation hands
it to extension `authorize` / `onResult` hooks.

**MCP** fills both fields from the connection when the caller sends none —
`agent` from the `initialize` handshake's `clientInfo.name`, `session_id` from a
per-process id (over stdio, one process is one client connection). Caller values
win, merged per key, so supplying only `agent` still gains a session id.

**CLI** gains three global flags: `--agent <name>`, `--session <id>` and a
repeatable `--client <key=value>`, with `CONTEXTNEST_AGENT` /
`CONTEXTNEST_SESSION_ID` as env fallbacks so a wrapping agent sets them once per
session. `ctx history` renders the recorded block on each version, distinct from
`By:`, which is the authoring identity. Values from `--client` are stored as
strings — coercing `version=1.0` to `1` would lose characters from an audit
record.

`client` is a label, not an identity claim: never authenticated, never used to
authorize, and deliberately not an input to any hash chain, so histories
recorded before the field existed keep verifying byte-for-byte. It is bounded
(scalar values ≤ 512 chars, ≤ 16 custom keys) because it lands in an append-only
audit trail, and a near-miss on a reserved key (`sessionId`) is rejected rather
than filed as a custom key, which would leave the write silently unattributed.
It is distinct from the `metadata` argument, which is frontmatter and describes
the document rather than the call.

Specified in `CONTEXT_NEST_SPEC.md` §9.4 (with §9.4.1 reserved/custom keys and
§9.4.2 binding conventions), and the `client` field on version entries in §6.2.
