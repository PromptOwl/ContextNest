---
"@promptowl/contextnest-cli": patch
---

Finish `ctx` support for a nest that requires confirmation for agent writes.

- `ctx add` against a remote vault no longer reports a held create as `Error [PENDING_CONFIRMATION]` with exit 1. It prints the nest's message, notes that the document does not exist until a reviewer confirms it, and exits 0, the same as `ctx push --no-wait`.
- `ctx push` now lists documents the server `skipped` (already exists, never overwritten) and `failed`, and exits 1 when any failed. Before, it printed "Pushed N" and exited 0. After a confirmed push, it reports how many held documents were not created.
- The `Confirm in the UI:` hint now links the nest page on the server. Before, it printed the reviewer's confirm API path, which is relative and not a page.
