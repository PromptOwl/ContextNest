---
"@promptowl/contextnest-mcp-server": major
"@promptowl/contextnest-engine": major
"@promptowl/contextnest-cli": major
---

## Major Release: Governance, Integrity, and Workflow Overhaul

This release introduces a comprehensive governance and integrity system across the ContextNest engine, CLI, and MCP server. Document updates can now be managed through an approval workflow, all mutations are recorded in a per-document hash chain, and production deployments are expected to provide RBAC enforcement.

### Suggestion-Based Document Governance

Documents are no longer limited to direct writes. Changes can now be staged as suggestions and reviewed before being applied.

New engine APIs:

- `stageSuggestion()`
- `listSuggestions()`
- `readSuggestion()`
- `quarantineSuggestion()`
- `approveSuggestion()`
- `rejectSuggestion()`
- `rollbackDocument()`
- `czarDirectEdit()`

This workflow enables:
- Human-in-the-loop approval
- Auditability for all document changes
- Controlled rollback of approved edits

### RBAC Enforcement

Governance actions are protected by the new `RbacHook` interface.

Production integrations must provide a real RBAC implementation and supply actor metadata for all privileged operations.

The CLI continues to use a permissive development stub for local use.

### Hash Chain and Integrity Verification

Every document mutation is now recorded in an append-only hash chain using:

- `ChainEventLog`
- `HashChainEvent`

New integrity features include:

- `detectDrift()`
- `verifyRemoteDelta()`
- Checkpoint drift validation
- `UNSTAGED\_DRIFT\_SENTINEL`

New errors:

- `ChainBreakError`
- `ZoneChallengeError`
- `QuarantineError`
- `UnauthorizedActionError`

These changes significantly improve tamper detection and auditability.

### Classification and Multi-Zone Security

ContextNest now supports classification-aware governance with:

- Classification manifest parsing
- `classifyDocument()`
- Zone challenge detection

New governance types include:

- `GovernanceTier`
- `SuggestionSource`
- `PendingChange`
- `SuggestionMeta`

This enables stronger controls for multi-zone and high-security vault deployments.

### Storage and Indexing

Index regeneration is now centralized in:

- `NestStorage.regenerateIndex()`

CLI and MCP workflows now rely on this engine API rather than maintaining separate indexing logic.

### CLI Updates

The `contextnest` CLI adds support for the suggestion workflow:

- `contextnest stage <path>`
- `contextnest list <path>`
- `contextnest approve <path> <suggestionId>`
- `contextnest reject <path> <suggestionId>`

Index-related commands now use `NestStorage.regenerateIndex()`.

### MCP Server Updates

The MCP server now exposes tools for:

- Staging suggestions
- Listing suggestions
- Approving suggestions
- Rejecting suggestions

Vault mutations automatically trigger `NestStorage.regenerateIndex()`.

### Hygienist Scan

Added `runHygienistScan()` to perform vault hygiene and consistency checks.

### Migration Guide

If you are upgrading from a previous version:

1. Replace direct write flows with `stageSuggestion()` and `approveSuggestion()` where governance applies.
2. Use `czarDirectEdit()` only for trusted administrative edits.
3. Implement and configure a production `RbacHook`.
4. Run `verify` and checkpoint workflows after upgrading.
5. Perform a one-time integrity pass for existing vaults if needed.

### Why This Release Matters

This release transforms ContextNest from a direct-write document store into a governed, auditable, and security-aware knowledge platform with:

- Approval-based document workflows
- Role-based access control
- Cryptographic integrity verification
- Classification-aware enforcement
- Unified CLI and MCP governance tooling
