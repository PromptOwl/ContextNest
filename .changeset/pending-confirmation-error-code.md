---
"@promptowl/contextnest-engine": minor
---

Add `PENDING_CONFIRMATION` to the operation error catalog (`ERROR_CODES`) and to `context_create`'s declared errors. A governed host that holds agent writes for a reviewer (the Community push-confirmation gate) answers a create with this code: the write was accepted, not failed, and does not exist until a reviewer confirms it. Clients can now branch on the canonical code instead of a host-local string.
