---
"@promptowl/contextnest-cli": patch
---

Fix: starter recipes scaffolded documents with an invalid node type

Every node in all five populated starter recipes (`developer`, `executive`,
`analyst`, `team`, `sales`) shipped `type: context` — a value that has never
been part of `NODE_TYPES`. `ctx init --starter` writes and publishes without
validating, so the vault looked healthy until the first `ctx update` or
`ctx validate` on a scaffolded document, which failed with:

```
Rule 6: Invalid enum value. Expected 'document' | … | 'table', received 'context'
```

All 15 nodes now declare `type: document`.

Two tests lock it down: a unit test runs the real parser and validator over
every node of every registered recipe (so any invalid frontmatter value fails
fast, not just this field), and a regression test asserts that a freshly
initialized starter vault passes `ctx validate` and that a scaffolded document
can be updated.

**Existing vaults are not migrated.** A vault created by an earlier release
still holds `type: context` on disk and will keep failing validation. Fix it in
place, e.g.:

```bash
grep -rl '^type: context$' nodes/ | xargs sed -i 's/^type: context$/type: document/'
ctx index
```
