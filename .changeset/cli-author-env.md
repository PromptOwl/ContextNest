---
"@promptowl/contextnest-cli": minor
---

Every local CLI write records the human author as `edited_by`. Set it with the global `--author <email>` flag or the `CONTEXTNEST_AUTHOR` env var; the flag wins, and with neither the value stays `cli@contextnest.local`. Commands with their own `-a, --author` (`publish`, `forget`, `archive`, paper imports) read the same value, so the env var is their default. `client.agent` (`--agent` / `CONTEXTNEST_AGENT`) is unchanged, and one version can carry both.
