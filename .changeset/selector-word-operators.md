---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

A selector with `OR`, `AND` or `NOT` written as words (`#a OR #b`) now fails with a hint naming the right operator (`|`, a space or `+`, `-`) instead of suggesting `nodes/OR` or `#OR`. `ctx validate` also checks every pack's `query` and reports one that won't parse, so a broken pack shows up before someone queries it.
