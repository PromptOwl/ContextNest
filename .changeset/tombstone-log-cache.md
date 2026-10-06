---
"@promptowl/contextnest-engine": patch
---

**Publishing no longer re-reads the whole forget log each time.** Every publish checks the vault's forget log so forgotten content cannot come back, and that meant reading and parsing the entire log — which grows with every delete and forget — on every publish. The parsed log is now reused until the file's size or modification time changes, so a publish costs one file stat instead of a full read. A forget recorded by any process on the same storage changes the file and is picked up on the next check, so the protection is unchanged.
