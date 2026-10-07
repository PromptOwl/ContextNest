---
"@promptowl/contextnest-cli": patch
---

First-run hints: `ctx add` re-roots a path outside `nodes/`/`sources/` (structured vaults) under `nodes/` and says so, instead of writing a file that list and search never see. The held-for-review notice now says the document is not visible to search or agents until approved, and an empty `ctx search` names held matches ("N matching documents are held for review…: ctx review list") instead of a bare "No results found."
