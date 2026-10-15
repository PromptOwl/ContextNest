---
"@promptowl/contextnest-engine": patch
---

**Large imports and whole-vault crawls keep their I/O slots busy.** Bounded-parallel work (import staging and checks, bulk publish, history reads, vault scans) ran in fixed batches: each batch waited for its slowest file before the next started, so on a network mount (Cloud Storage via gcsfuse) one slow round trip left the other slots idle. It now runs as a sliding pool — the next file starts as soon as any finishes — with the same bound on files in flight and results still in input order. Hosts can also raise that bound for `context_import` with the new `OperationContext.limits.ioConcurrency` (default 32 file operations; bulk publish runs half as many documents). The value is the host's to set, never a caller input.
