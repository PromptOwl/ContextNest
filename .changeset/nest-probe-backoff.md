---
"@promptowl/contextnest-cli": patch
---

An offline Community server no longer slows every prompt. A failed nest-list probe behind a server alias is remembered for 60 seconds, so `ctx vault list` (which the Claude Code plugin runs on each prompt) skips it instead of waiting out another timeout. A live connection ignores the marker, and the next success replaces it. Also: `ctx vault list` no longer modifies the entries it is given, and `ctx update --help` says that `--tags ""` removes every tag.
