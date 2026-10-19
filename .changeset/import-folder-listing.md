---
"@promptowl/contextnest-engine": patch
---

**Importing files checks for name collisions with one listing per folder.** `context_import` with `files[]` used to check every incoming path with its own existence check — a network round trip per file on a Cloud Storage mount, about a third of all storage operations a large import made. It now lists each target folder once and compares names case-folded, so a name a case-insensitive file system already holds (`Notes.md` against an incoming `notes.md`) still counts as taken and the incoming file lands beside it as `notes-2.md`.
