---
"@promptowl/contextnest-cli": minor
---

Add `ctx login` / `ctx logout`: sign in to a ContextNest server once in the browser and the CLI keeps its own API key in the secure credential store (OS keyring, else the encrypted file — never plaintext). `ctx push` uses the saved key when neither `--key` nor `CONTEXTNEST_API_KEY` is given, and a remote registered with `ctx vault add <alias> --url <server>/mcp` and no `--bearer-env` authenticates with it. `--key-stdin` saves an existing key without putting it in argv.
