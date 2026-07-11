---
"@promptowl/contextnest-engine": minor
---

Add consumer-facing seams so the community server and TheOwl stop hand-rolling engine-owned logic:

- **Stewards format** — `parseStewards` / `serializeStewards` / `STEWARDS_FILENAMES` + types. Canonical marshalling for `stewards.yaml` (format only; enforcement stays with the consumer).
- **Wiki-link plumbing** — `extractWikiLinks` / `buildWikiTitleIndex` / `resolveWikiSeeds` / `traverseWikiGraph`. Pure, **ungated** primitives for `[[Title]]` seed resolution + hop traversal (the eligibility gate stays with the consumer).
- **Fix** — `serializeDocument` now drops `undefined`-valued frontmatter keys instead of throwing `[object Undefined]` (these arise from the engine's own `normalizeTags([]) → undefined`). Lets consumers delete their `safePublishDocument`-style workarounds.
