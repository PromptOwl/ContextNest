---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": patch
---

Invalid input no longer surfaces as a Node.js crash. `ctx resolve "tag:"` printed a raw stack trace with internal file paths because the selector lexer/parser threw plain `Error`, which the CLI's top-level handler deliberately rethrew.

- **Engine:** new `InvalidSelectorError` (`INVALID_SELECTOR`, §2) thrown by the selector lexer and parser in place of plain `Error`; `VersionManager.reconstructVersion` now throws coded `VERSION_NOT_FOUND` / `RECONSTRUCTION_FAILED` (§6). These were the only uncoded throws left in `packages/*/src`, so every engine failure now carries a `code`.
- **API catalog:** `ERROR_CODES` gains `INVALID_SELECTOR`, `VERSION_NOT_FOUND`, `RECONSTRUCTION_FAILED`; `context_reconstruct` advertises the latter two and passes them through instead of flattening missing history into `VALIDATION_FAILED`; `context_query` / `context_resolve` advertise `INVALID_SELECTOR`.
- **CLI:** the top-level handler renders *every* error as a one-liner (`Error [CODE]: message`), including YAML syntax errors, fs failures, and genuine bugs. Stack traces are still available on demand via `CONTEXTNEST_DEBUG=1`. Exit code stays non-zero.

Behavioral note for API consumers: `context_reconstruct` on a document with no version history now rejects with `VERSION_NOT_FOUND` rather than `VALIDATION_FAILED`.
