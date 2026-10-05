---
"@promptowl/contextnest-cli": patch
---

Harden the `ctx push` confirmation-gate poll.

- A redirect on the poll request now fails at once. It was refused but then retried, so the CLI kept polling until the timeout (15 minutes by default).
- A `202` envelope whose `poll_url` is not a path (e.g. `@evil.example/x`) is now treated as unrecognized ("not applied", exit 1). `poll_url` is appended to `--server` and the poll carries the API key, so a non-path value could send the key to another host.
