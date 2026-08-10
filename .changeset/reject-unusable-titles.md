---
"@promptowl/contextnest-engine": patch
---

Reject titles and ids that carry no usable characters

A title of `###`, `...`, `!!!` or spaces slugifies to nothing. `context_create` already refused it, but a server that derives the id itself and calls the storage primitives directly went straight through: the document was written to `nodes/.md`, a dotfile discovery never lists, no id can address, and the next symbols-only title collided with. The write reported success and left a document nobody could open or delete.

- `assertSafeDocumentId` — which `normalizeDocumentId`, `publishDocuments` and the update path all funnel through — now rejects any path segment with no letter or number, alongside the existing `..` traversal check. The rule is `\p{L}`/`\p{N}`, not the a-z0-9 slug rule, because existing ids are read back through the same guard and a vault may legitimately hold `nodes/日本語`.
- `context_update` validates a supplied `title` with the same `requireSlug` rule `context_create` uses. A rename leaves the id alone, but an unusable title is still read back by title→id resolution, search and wiki links.
