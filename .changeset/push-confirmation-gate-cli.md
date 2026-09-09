---
"@promptowl/contextnest-cli": minor
---

`ctx push`: honor a nest's push-confirmation gate instead of misreporting a pending push as applied.

A hosted nest can require a human to confirm an incoming push in the web UI before it is applied. When it does, the publish endpoint answers `202 { status: "pending_confirmation", … }` and parks the documents rather than applying them. `ctx push` treated any 2xx as success, so against a gated nest it printed "Pushed N documents" though nothing had landed.

- On `202 pending_confirmation`, the CLI now prints the server's message and a `Confirm in the UI: <confirm_url>` line, then — unless `--no-wait` — polls `poll_url` (`/nests/:id/pending-pushes/:pid`, same Bearer key) on a capped 2s→10s backoff until the decision.
- The process exit code reflects the outcome: `0` when the push is applied, non-zero for rejected / expired / timeout.
- New flags: `--no-wait` (submit, print the confirm URL, exit 0 without polling) and `--timeout <sec>` (default: the server's `expires_at` window, else 15m).
- The 200 path (ungated / allowlisted nests) is unchanged.

Wire contract shared with the paired Community server change (PromptOwl/contextnest-community).
