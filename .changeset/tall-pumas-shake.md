---
"@promptowl/contextnest-cli": minor
---

CLI file-safety hardening: confirmation prompts, `--dry-run`, and an action log

No `ctx` command now writes to your working directory without saying so.

- **`--dry-run`** on every write command. It runs the real operation against a
  throwaway copy of the vault, reports the exact files that would change, and
  leaves your vault untouched — so the preview never drifts from what the
  command actually does.
- **Action log.** Write commands end with the list of files created (`+`),
  modified (`~`) or deleted (`-`), computed by diffing the vault before and
  after. Written to stderr so `--json` output and redirected stdout stay clean.
- **Confirmation prompts.** Interactive runs ask first; destructive commands
  (`delete`, `checkpoint rebuild`, `drift approve`, `vault remove`, re-running
  `init` over an existing vault, overwriting a `read --out` target, `push`)
  default to "no". Non-interactive callers are never blocked on stdin —
  additive commands proceed, destructive ones refuse unless `--yes`/`--force`
  is passed.
- **No silent overwrites.** `ctx read --html --out <file>` refuses to clobber an
  existing file without `--force`.
- **Safer egress.** `ctx push` lists the documents leaving the machine before
  sending them, refuses plaintext HTTP to a non-loopback host (which would
  expose documents and the API key on the wire), and accepts the API key from
  `CONTEXTNEST_API_KEY` so it need not appear in argv or shell history. The
  same protocol check covers a `PROMPTOWL_API_URL` override.

Behavior change for scripts: `ctx delete`, `ctx checkpoint rebuild`,
`ctx drift approve`, `ctx vault remove` and `ctx push` now require `--yes` (or
`--force`) when there is no TTY.
