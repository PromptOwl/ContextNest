---
"@promptowl/contextnest-engine": patch
---

Vaults imported before versions were made whole numbers no longer corrupt their checkpoint chain on every write. A published document still carrying a decimal front-matter version (`version: 2.1`) is recorded in the checkpoint as-is, and the checkpoint reader now accepts it instead of rejecting the whole `context_history.yaml` as `Expected integer, received float`, quarantining it as `.corrupt` and restarting the chain.
