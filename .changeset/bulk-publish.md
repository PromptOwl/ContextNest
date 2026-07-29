---
"@promptowl/contextnest-engine": minor
---

Add `publishDocuments()` — bulk publish for folder importers.

Publishing a large nest folder one file at a time via `publishDocument` is O(N²): each call seals its own checkpoint, and every checkpoint re-scans the entire vault (`discoverDocuments` + `findAllHistories` + a rewrite of the growing `context_history.yaml`). `publishDocuments(storage, ids, opts)` does the per-doc version work with bounded concurrency but seals **one** checkpoint for the whole batch and regenerates the index **once** — collapsing N full-vault rescans into a single pass. Failure-isolated: a bad/rejected file is reported in `failed[]` and skipped; the rest still publish. `publishDocument` is unchanged.

Also exposes this over the API catalog as the `context_import` core op — bulk create-and-publish from document payloads `{ documents: [{title, content, type?, tags?, folder?, metadata?}] }` → `{ created[], failed[] }`, composing on `publishDocuments` so every binding (agent/CLI/REST) gets one O(N) bulk-import tool. `core` namespace is now 16 ops.
