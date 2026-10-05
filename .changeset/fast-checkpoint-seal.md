---
"@promptowl/contextnest-engine": patch
---

Sealing a checkpoint no longer reads every document's history. Each publish seals one, and it used to read every `history.yaml` in the vault, under the vault lock. On a network-backed mount that is one round trip per document, so a single publish (a governance approval) took close to a minute on a large vault. The seal now reuses the previous checkpoint's chain hash for each document whose version did not change, and reads only the rest. A history that the same storage instance rewrote, moved aside or deleted is always read again, because a repair can re-hash a version without changing its number. Checkpoint contents are the same as before.
