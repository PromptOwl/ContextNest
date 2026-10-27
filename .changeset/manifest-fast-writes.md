---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

Writes no longer read the whole vault. A create, update or publish used to crawl every document to seal its checkpoint and rebuild `context.yaml`, so writes slowed as the vault grew (about 80% of each write; worse on a network-backed or hosted vault). The engine now keeps a manifest at `.context/manifest/manifest.json` (git-ignored, sealed in encrypted vaults) and re-reads only the folders a write touched. On a 3,000-document vault an update drops from ~465 ms to ~215 ms on local disk. Checkpoint and `context.yaml` formats are unchanged. A missing or stale manifest falls back to the full crawl and rebuilds itself.

Files added or edited outside the engine (an editor, `git pull`) reach the index on `ctx index`, which now runs under the vault lock and rewrites the manifest. Until then later checkpoints keep sealing what the manifest knows — a status changed by hand stays sealed as it was. `ctx verify` (and `context_verify`, as `stale_index`) now lists such documents as a warning — not an error, a hand edit is not tampering — so they are not missed. Suggestion approval (`approve_suggestion`, `ctx drift approve`) now updates the index under the vault lock too.
