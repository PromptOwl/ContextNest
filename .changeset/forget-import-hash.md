---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
"@promptowl/contextnest-mcp-server": patch
---

Anti-resurrection: `context_import` (and any other write) now refuses erased content under a new title. Forgotten bodies were matched by a hash of the raw body, so the same text wrapped in different blank lines (`ctx add` writes `"\nX\n"`, an import `"X"`) never matched. Bodies are now trimmed before hashing; the untrimmed hash is still checked so forgets recorded by earlier versions keep refusing an exact copy.
