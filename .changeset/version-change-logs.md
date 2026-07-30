---
"@promptowl/contextnest-engine": minor
---

Per-version change logs, and version numbering that can no longer graft a second chain onto a document's history.

**Change logs move out of `history.yaml` into their own files.** A non-keyframe version is now stored as `v{N}.diff` beside the keyframes — the unified diff taking the previous version to this one, hunk headers included, so each file is readable on its own and applies with standard patch tooling. `history.yaml` keeps metadata only, which matters because it is rewritten whole on every version: inline patches made each edit cost O(total history). Reads are backward compatible — `reconstructVersion` falls back to the patch stored inline by older histories, so existing vaults need no migration. New APIs: `NestStorage.readDiff`/`writeDiff`, `VersionManager.getDiff` (one small file read, no chain replay), and `VersionManager.externalizeDiffs` to move inline patches into files as a tidy-up.

`context_versions` gains an opt-in `include_diff` input and a matching optional `diff` field on each version entry. Off by default: a document with dozens of versions would otherwise return dozens of patches, which is a lot of tokens to push at an agent that only asked who edited what and when.

**Version numbers now outrank the recorded history, not just frontmatter.** `publishDocument`, `publishDocuments`, and the approval commit path all derive the next version from `VersionManager.nextVersion`, which takes the max of the caller's hint and every version already in `history.yaml`. Numbering from frontmatter alone let a document whose frontmatter lagged its history — an imported or copied vault, a restored backup, a doc whose frontmatter was reset — reuse a live version number: duplicate entries, `v{N}.md` keyframes overwritten at the same number, and `reconstructVersion` failing on the first diff after the graft, which made every later version unreadable.

Two recoveries for chains already in that state:

- `createVersion` falls back to writing a keyframe when the previous version cannot be reconstructed, instead of storing a diff against content it cannot rebuild. A broken chain heals on its next edit rather than failing forever.
- `VersionManager.repairLatestVersion` re-anchors a grafted chain's latest version on the live document and drops the graft tail, without adding a version or renumbering anything already recorded. Versions from before the graft stay unreadable — those bytes were overwritten and are gone.

`verifyDocumentChain` takes an optional fourth `readDiff` callback so a non-keyframe entry's hash is still checked once its patch lives in a file; `verifyVaultIntegrity` pre-loads those bytes the same way it already pre-loads keyframes. A non-keyframe entry with neither a diff file nor an inline patch now surfaces as `content_hash_mismatch` rather than passing silently — unlike a missing keyframe, a missing diff breaks every version after it.
