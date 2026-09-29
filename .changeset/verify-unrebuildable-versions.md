---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

Integrity check rebuilds every recorded version, and repair reports what a
reader can still be served

`ctx verify` / `context_verify` proved each version artifact matched what the
history *records* — never that the chain still *replays*. An import that
overwrote version artifacts and rewrote their fingerprints to match passed
every hash check, yet the diffs no longer applied and older versions read as
empty, surfacing only when a reader, export or agent asked for one.
Verification now also rebuilds every recorded, non-tombstoned version from its
keyframe+diff chain and reports each one that fails as a new error type,
`version_unreconstructable`, naming the document and version. Healthy vaults
still verify clean; tombstoned versions stay hash-only (§6.3.2), not errors.

`VersionManager.repairVersions(docId)` repairs what can be repaired and
reports the rest: it runs the existing idempotent `repairLatestVersion`
re-anchor, then returns `{ repaired, unreadable, newestReadable }` — every
recorded version that cannot be rebuilt, and the newest one that can. It never
creates a version and never renumbers one; only the saved history is
rewritten. Which version is approved for readers stays a product decision —
the engine only says what is readable. `repairLatestVersion` itself is
unchanged.

The replay core moved from `VersionManager.reconstructVersion` into a shared
`reconstructFromHistory` so verification replays the same algorithm over its
pre-loaded bytes; reconstruction behaviour is unchanged.
