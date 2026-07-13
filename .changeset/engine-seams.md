---
"@promptowl/contextnest-engine": minor
---

Add consumer-facing seams so the community server and TheOwl stop hand-rolling engine-owned logic:

- **Stewards format** — `parseStewards` / `serializeStewards` / `STEWARDS_FILENAMES` + types. Canonical marshalling for `stewards.yaml` (format only; enforcement stays with the consumer).
- **Wiki-link plumbing** — `extractWikiLinks` / `buildWikiTitleIndex` / `resolveWikiSeeds` / `traverseWikiGraph`. Pure, **ungated** primitives for `[[Title]]` seed resolution + hop traversal (the eligibility gate stays with the consumer).
- **Fix** — `serializeDocument` now drops `undefined`-valued frontmatter keys instead of throwing `[object Undefined]` (these arise from the engine's own `normalizeTags([]) → undefined`). Lets consumers delete their `safePublishDocument`-style workarounds.

Hardening on the above seams:

- `serializeStewards` now omits keys whose entry list is empty (e.g. `{ tags: { "#x": [] } }`), matching `parseStewards` so the round-trip is symmetric.
- `parseStewards`' lenient fallback (used only when strict YAML rejects legacy comma-joined shorthand) now accepts any sub-key indentation, not just 2 spaces — 4-space / mixed-indent legacy files no longer silently drop entries.
- `StewardRole` documented as the canonical set, not a runtime guarantee: the format-only parser preserves non-canonical role strings as authored, so consumers must not assume the union is exhaustive.
- `serializeDocument`'s undefined-strip is documented as shallow (top-level frontmatter only); a nested `undefined` would still throw. No current parser path produces one.
- `parseStewards`' lenient fallback now recovers an inline `version: N` instead of silently pinning legacy files to version 1 — symmetric with its role handling (no field is dropped just because strict YAML rejected the file's shorthand).
