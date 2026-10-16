---
"@promptowl/contextnest-engine": patch
---

**Importing publishes each document's new version as a full snapshot.** Storing a version as a diff first rebuilds the previous version from its keyframe and every diff since — on a Cloud Storage mount, a round trip per artifact for every imported document that already carries history. `context_import` with `discover` or `files[]` now stores that version as a keyframe instead, which reads nothing back. Each imported document keeps one extra full copy on disk, and `ctx history --diff` shows no diff for that one version. Publishing by `ids` only (bulk approval) still stores diffs.
