---
"@promptowl/contextnest-cli": patch
---

`ctx verify` reads each version's change log from its own file, so non-keyframe entries are hash-checked again now that patches live beside the keyframes rather than inside the history index. Without this, verify reported a mismatch for every version that carried a patch.

`ctx add` refuses a path that already holds a document, with `DOCUMENT_EXISTS`, and leaves the existing file untouched. It previously failed only by accident: the template it writes resets the version to 1, which collided with a number already in the chain and blew up during publish — after the original bytes had already been overwritten.
