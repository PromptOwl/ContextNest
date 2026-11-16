---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

Archive and move are engine operations. `context_archive` takes a node out of lists and retrieval and keeps its history; `context_unarchive` restores the status it left. `context_move` moves a node with its history and any PDF, so `ctx move` now works on local vaults. `ctx archive` and `ctx unarchive` are new. The engine also exports `moveDocument`, `restoreSealedVersion` and `readVersionSource` for hosts that keep their own records beside the vault.
