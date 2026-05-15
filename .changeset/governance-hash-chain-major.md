---
"@promptowl/contextnest-engine": major
"@promptowl/contextnest-cli": major
"@promptowl/contextnest-mcp-server": major
---

## Breaking changes

### Document governance and suggestions

- Documents can be changed through a **suggestion workflow** (`stage` → `approve` / `reject`) instead of only direct writes.
- New APIs: `stageSuggestion`, `listSuggestions`, `readSuggestion`, `quarantineSuggestion`, `approveSuggestion`, `rejectSuggestion`, `rollbackDocument`, `czarDirectEdit`.
- **RBAC hooks** (`RbacHook`) gate actions; callers must supply an actor and an appropriate hook in production (CLI uses a permissive local stub).

### Hash chain and integrity

- Per-document **hash chain** logging via `ChainEventLog` and `HashChainEvent` types.
- Expanded **integrity** and **drift** detection (`detectDrift`, `verifyRemoteDelta`, checkpoint drift handling).
- `NestStorage.readDocument` supports options; `UNSTAGED_DRIFT_SENTINEL` for unstaged drift semantics.
- Stricter errors: `ChainBreakError`, `ZoneChallengeError`, `QuarantineError`, `UnauthorizedActionError`, etc.

### Classification and zones

- **Classification manifest** parsing, `classifyDocument`, and **zone challenge** detection for multi-zone vaults.
- New governance types: `GovernanceTier`, `SuggestionSource`, `PendingChange`, `SuggestionMeta`.

### Storage and indexing

- Index regeneration centralized on **`NestStorage.regenerateIndex()`** (replaces duplicated logic in CLI/MCP).
- Checkpoint, publish, parser, and schema updates aligned with chain and governance behavior.

## CLI (`contextnest`)

- New commands: `stage <path>`, `list <path>`, `approve <path> <suggestionId>`, `reject <path> <suggestionId>`.
- `index` and related flows use engine `regenerateIndex()`.

## MCP server

- MCP tools updated for suggestion staging, listing, approve, and reject (aligned with CLI).
- Uses `NestStorage.regenerateIndex()` after vault mutations.

## Migration

- Integrations that wrote documents directly should move to **stage + approve** where governance applies, or use `czarDirectEdit` where appropriate.
- Deployments must provide a real **RBAC hook** (not the CLI dev stub).
- Run `verify` / checkpoint flows after upgrade; existing vaults may need a one-time integrity pass depending on prior usage.

## Other

- **Hygienist**: `runHygienistScan` for vault hygiene checks.
- Large test coverage added for approval, chain log, classification, RBAC, suggestions, drift, and integration paths.
