---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

feat: identity-agnostic governance seams, user-level read/commit gates, and provenance

**Engine**
- New `GovernanceHooks` interface (superset of `RbacHook`) adds optional `canRead(actor, target)` and `canCommit(actor, target, operation)` gates. Absent hooks/methods mean allow, so every existing caller and `RbacHook` implementation keeps working unchanged.
- Per-call opt-in enforcement on `NestStorage.readDocument`/`readDocuments`/`writeDocument`/`deleteDocument`, `GraphQueryEngine.query` (post-traversal read filtering — denied nodes never surface but may still bridge hops), `publishDocument` (commit gate before any mutation), and `stageSuggestion`.
- New provenance plumbing: `ProvenanceOrigin` (`{client, tool, session_id, agent}`) is stored on version entries, chain events, suggestion metas, and access traces — **outside all hash inputs**, so existing hash chains and vaults verify unchanged (older engines simply strip the field on parse; rewriting history with an old engine drops `origin` but never breaks integrity). `ProvenanceRecorder` is a best-effort audit sink mirrored from publishes, queries, governance actions, and the chain event log; recorder failures never fail the operation.
- New `loadGovernanceBundle()` loader resolves a deployment's governance module from an explicit option, `CONTEXTNEST_GOVERNANCE_MODULE`, or the vault's `.context/config.yaml` `governance.module` field. Misconfigured modules throw `ConfigError` (fail loud, never silently open).
- New exports: `denyAllGovernance`, `allowAllGovernance`, `requireRead`, `requireCommit`, `filterReadable`, `recordProvenance`, `provenanceOriginSchema`, `GOVERNANCE_MODULE_ENV`.

**CLI**
- Global `--actor` option (defaults to `CONTEXTNEST_ACTOR` env, then `cli-user`).
- Loads a governance module at startup when configured and threads actor + `origin: {client: "cli", tool: <command>}` through read/query/publish/update/delete/drift commands. Unauthorized actions exit non-zero with a clean message. Without a configured module, behavior is identical to previous releases.

**MCP server**
- Loads a governance module at startup when configured. Actor precedence: per-tool `actor` argument (attribution, not authentication) → `CONTEXTNEST_ACTOR` → `local-mcp`. Read tools gate/filter per actor; mutation tools enforce commit permissions; denied calls return MCP tool errors instead of crashing. Without a configured module, behavior is identical to previous releases.

The proprietary stewardship implementation of these seams (roles, per-user/per-document policy, provenance store) lives in the new source-available, commercially licensed `packages/governance` — excluded from npm publishing and from the repository's AGPL license (see `NOTICE`).
