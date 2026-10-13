---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

A selector with `OR`, `AND` or `NOT` written as words (`#a OR #b`) now fails with a hint naming the right operator (`|`, a space or `+`, `-`) instead of suggesting `nodes/OR` or `#OR`. `ctx validate` also checks every pack's `query` and reports one that won't parse, so a broken pack shows up before someone queries it. It also reports a pack file that is not valid YAML or is missing a required field (both used to crash validate or be skipped silently), and packs saved as `.yaml` are now read alongside `.yml`. In `ctx validate --json`, pack errors carry a string `rule` (`"pack-query"` or `"pack-file"`) where document rules are numbers.
