---
"@promptowl/contextnest-engine": patch
---

**Importing a document with a fractional version no longer publishes a fractional version.** A hand-edited `version: 1.1` was bumped to `2.1` on publish, and a host that stores versions in an integer column (Community on Postgres) refused the whole import. Import now repairs a `version` that is not a whole number of at least 1 (rounded down, else `1`) and reports it in `warnings`, like the other frontmatter repairs. As a backstop, every publish rounds a fractional frontmatter version down before bumping it, so no write path can mint one.
