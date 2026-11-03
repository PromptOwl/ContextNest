---
"@promptowl/contextnest-engine": minor
---

A view's `html` block may now declare `write_to`: the ids of earlier `data` blocks its artifact is allowed to write rows back to. Each entry must name an earlier block (the same rule `data_from` follows) and that block must be a `data` block; anything else is refused under §13 rule 35. The field only declares intent — the host still decides on every write whether the viewer may. Views without `write_to` validate exactly as before.
