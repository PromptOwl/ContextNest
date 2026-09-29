---
"@promptowl/contextnest-engine": patch
---

Hubs now need at least three inbound references (`HUB_MIN_DEGREE`). Edges into a hub are free to traverse, and without a floor every linked document in a small vault became a hub, so `ctx query <node> --hops 0` also returned the documents that node links to. Scoped queries (for example, per-question evidence) could pull in neighbouring context they were never meant to see.
