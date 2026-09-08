---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

Rank `ctx search` / `context_search` by relevance, attach a `score` to every hit, and default `--limit` to 10.

On a 673-document vault, `ctx search "strategy roadmap 2026"` returned 607 hits with the first screen sorted alphabetically by id — the strategy node itself was nowhere near the top. The resolver's MiniSearch index had scored the hits correctly, but the selector evaluator collapsed them into a `Set` and then filtered the discovery list against it, which re-sorted every match into id order and dropped the score; and because the executor had to slugify the query into one lexer-safe URI token, the hyphen-joined words ran as an OR search, so nearly every document matched. `context_search` now calls the resolver's new `search()` directly with the raw query: documents matching every query term come first, then partial matches, each tier by descending BM25 score, and each result carries a numeric `score` plus a top-level `total` (matches before `limit`). The evaluator now preserves the resolver's order, so `ctx query "contextnest://search/…"` in full mode comes back ranked too. `ctx search` prints the top 10 unless `--limit` says otherwise (`--limit 0` prints everything) and, when the list is cut, ends with `… N more — raise --limit`; `--json` includes `score`. Remote nests get the same rendering, degrading gracefully when the remote engine sends no `score`/`total`.
