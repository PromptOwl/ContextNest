---
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-engine": minor
---

`ctx login`: a key saved for one nest (`--nest <id>`) now works through a server alias as `--vault <alias>/<nest>`, even with no server-wide key saved. The alias lists the nests every saved key can see, and a command naming one nest signs in with that nest's key (else the server-wide one). `ctx login --account <name>` keeps a second account's keys on the same server, and an HTTP remote picks it with the new optional registry field `account` (`ctx vault add … --url … --account <name>`); `ctx logout` and `ctx login --list` take `--account` too. Keys saved without `--account` are unchanged.
