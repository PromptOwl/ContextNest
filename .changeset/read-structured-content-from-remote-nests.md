---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

Read the `structuredContent` half of a remote nest's reply.

A nest that also serves chat clients answers with human-readable prose in
`content` and the catalog payload alongside it in `structuredContent`. The
remote client only read `content`, so every operation against such a nest
failed as "returned a non-JSON payload" — and on the error path a typed
`DOCUMENT_NOT_FOUND` was downgraded to `INTERNAL`. Both paths now read the
structured half when it is there, and fall back to parsing the text when it
is not.

Follow-on fixes for what that contract implies:

- `context_versions` no longer requires `keyframe_interval`, `keyframe`,
  `content_hash` or `chain_hash` — a nest that stores content whole and
  enforces integrity server-side has no keyframe+diff model and omits them.
  The equivalents it does report (per-version `status`, top-level
  `approved_version`) are now part of the schema, and `ctx history` reads them
  instead of labelling every approved version "draft".
- `ctx publish` against a nest that publishes through steward review falls
  back to `context_submit_review` and reports the node as submitted rather
  than published.
- `ctx verify` against a nest that exposes no `context_verify` refuses with a
  clear message instead of failing on an unknown tool.
