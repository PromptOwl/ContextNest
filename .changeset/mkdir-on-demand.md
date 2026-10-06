---
"@promptowl/contextnest-engine": patch
---

**A publish no longer re-creates directories that already exist.** Every write on the publish path — the document, its diff or keyframe, its history entry, the checkpoint, each folder index and each agent configuration file — first ran a `mkdir -p` on its directory, about ten per publish, and on network-backed storage each one is a round trip even when the directory is already there. Writes now go straight to the file and create the directory only if it turns out to be missing, then write once more; the checkpoint append, which only ever extends an existing file, no longer touches directories at all. A publish into an existing folder drops from twelve directory calls to the two the vault lock needs. New folders are still created on demand, and nothing is kept in memory.
