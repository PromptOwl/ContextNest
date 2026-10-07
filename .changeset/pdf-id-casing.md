---
"@promptowl/contextnest-engine": patch
---

**A PDF import resolves an explicit id to its on-disk casing (#117).**

On a case-insensitive filesystem (macOS, Windows), `context_import_pdf` / `ctx import pdf --id nodes/report` finds an existing `nodes/Report.md`, but used to carry on under the caller's spelling: it versioned the node as `nodes/report`, wrote the sidecar to `nodes/report.pdf` and recorded `pdf.file: nodes/report.pdf`, which then failed validation rule 26 against the id discovery reports. The import now resolves the id to the spelling each directory lists before it derives the sidecar path, `pdf.file` or the version history from it, and returns that id. `deleteDocument` likewise removes a pdf node's sidecar when the node is addressed in another casing. A node written before this fix, whose `pdf.file` carries the caller's casing, is repaired by a same-bytes re-import, and is still deleted with its sidecar when addressed in that casing. On a case-sensitive filesystem nothing changes.

New: `NestStorage.resolveDocumentIdCasing(id)`.
