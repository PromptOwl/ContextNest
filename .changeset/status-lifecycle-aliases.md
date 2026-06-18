---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

Replace `status: superseded` with a four-value canonical set + alias normalization.

**Canonical statuses:** `draft`, `pending_review`, `approved`, `published`, `rejected`.

- `draft` — editable scratch, hidden by default, surfaces with `includeDrafts: true`.
- `pending_review` — author submitted, reviewer not yet signed off. Hidden from LLM, visible to stewards.
- `approved` — reviewer signed off; not yet live. Hidden from LLM retrieval.
- `published` — only canonical status surfaced to LLM retrieval by default.
- `rejected` — terminal hide. `publishDocument` throws `RejectedDocumentError` to prevent silent resurrection.

**Aliases (case-insensitive)** normalize to canonical at parse/write time. Unknown values fall back to `draft`. Shipped map covers `cancelled`/`canceled`/`archived`/`abandoned`/`deprecated`/`removed` → `rejected`; `superseded`/`todo`/`pending`/`wip`/`new` → `draft`; `review`/`in_review`/`in-review`/`under_review`/`under-review`/`submitted`/`needs_review`/`needs-review`/`awaiting_review`/`awaiting-review` → `pending_review`; `ready`/`reviewed`/`accepted`/`signed_off`/`signed-off` → `approved`; `active`/`live`/`released`/`final`/`shipped` → `published`.

**Engine API additions:** `normalizeStatus`, `STATUS_ALIASES`, `isDraft`, `isPendingReview`, `isApproved`, `isRejected`, `RejectedDocumentError`.

**Deprecations (kept for back-compat, never thrown post this release):** `SupersededDocumentError`, `isSuperseded`. `storage.discoverDocuments({ includeSuperseded })` is accepted as an alias for `{ includeRetired }`.

**CLI:** `ctx update --status`, `ctx list --status` accept aliases. `ctx index` rewrites any aliased on-disk status to canonical.

**MCP:** `update_document` and `list_documents` accept alias values and persist canonical. `document_format` returns the full alias map.

**Spec:** `CONTEXT_NEST_SPEC.md` §1.5 + new §1.5.1 document the lifecycle + alias rules.

Legacy `status: superseded` on disk is auto-normalized to `draft` at parse time — no data migration required.
