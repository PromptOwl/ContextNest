---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

Anti-resurrection: `context_import` (and any other draft write) now refuses erased content under a new title. The check hashed the draft as serialized, while a forget records the hash of the published, re-parsed file (one extra leading newline), so the same body never matched. Both forms are now checked.
