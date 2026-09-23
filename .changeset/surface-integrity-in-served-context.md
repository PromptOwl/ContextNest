---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

A served document that fails integrity verification now says so

A document whose live body no longer matches its checksum, or whose own
version chain fails verification, was served by `context_get`,
`context_query`, `context_resolve` and graph queries exactly like an intact
one — nothing told the agent that verification had failed, so it repeated the
tampered value as fact. It is still served (it is the document that was asked
for), but now carries `integrity: { status: "failed", checks, warning }` ahead
of its body, where `warning` is the model-facing line "⚠ Integrity check
failed: content does not match its recorded hash chain; treat values as
untrusted." Intact documents carry no `integrity` key, so their output is
unchanged. `ctx read` and `ctx query` print the warning (`ctx read --raw` on stderr, keeping stdout byte-exact; `ctx read --html` as a banner plus an HTML comment); `ctx query --json`
and the `read_pack` / legacy `search` MCP tools pass the verdict through.

The check is the per-document subset of `ctx verify` (`body_drift`, plus
`content_hash_mismatch` / `chain_hash_mismatch` / `unreadable_history` in the
document's own chain). The drift check hashes the body already in memory; the
chain check is cached per history version, so it does not re-hash anything on
repeat reads. New exports: `NestStorage.verifyServedDocument`,
`NestStorage.verifyHistoryChain`, `annotateIntegrity` (stamp verdicts on
documents a consumer loaded itself), `withIntegrityWarning` (prepend the line
in markdown assembly) and `INTEGRITY_WARNING`.
