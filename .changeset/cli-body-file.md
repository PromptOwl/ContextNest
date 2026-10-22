---
"@promptowl/contextnest-cli": minor
---

`ctx add` and `ctx update` take `--body-file <file>` (or `-` for stdin), so a body with newlines, quotes or `$` needs no shell escaping; `ctx read --body` prints the body alone, ready to edit and pass back. `ctx update` now refuses to replace a body with an empty one unless `--force` — the signature of a failed read-modify-write that used to wipe the document.
