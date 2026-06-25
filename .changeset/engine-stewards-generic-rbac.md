---
"@promptowl/contextnest-engine": minor
---

Add governance building blocks for SDK consumers.

**Steward stores** — two Mongo-backed stores ship from the engine, both implementing the same `BaseStewardStore` contract so permission code stays store-agnostic:

- **`SingleUserStewardStore`** — one row per (scope, target, user). Matches the contextnest-community canonical shape.
- **`MultiUserStewardStore`** — one row per (scope, target) with embedded `users[]` + `teams[]`. Matches PromptOwl TheOwl's multi-user-per-doc shape.

Both expose `resolveStewards(nestId, { nodeId?, tags? })` returning a flattened `ResolvedStewardEntry[]` ordered by priority (document > tag > nest). `MultiUserStewardStore` extends with `teamIds?` — the engine has no team membership knowledge, so the caller is the authority. No teamIds = team grants suppressed.

**Generic RBAC surface** — `RbacHook` is now fully optional. Wire only the surface you need:

- `canEdit(actor, docId)` + `canApprove(actor, docId)` — the conventional editor/reviewer model most apps use. Asserted via new `requireEdit` / `requireApprove` helpers.
- `isCzar` / `canIngest` / `isDocOwner` — kept first-class as optional, so existing PromptOwl deployments and OSS consumers who want the zone-classification tier-aware model can opt in.

Missing methods are treated as deny (never silent allow).

**Hash chain event types** loosened — `hashChainEventSchema.event_type` now accepts any non-empty string. The `HASH_CHAIN_EVENT_TYPES` constant + `WellKnownHashChainEventType` union remain as documentation + autocomplete for the PromptOwl-flavored vocabulary, but OSS consumers can emit their own event names (e.g. `"document.approved"`) without forking the engine.

**Config field rename** — `NestConfig.sync.external_workspace_id` is the new canonical key. `promptowl_data_room_id` is kept as a deprecated alias for one release; `parseConfig` collapses it into the canonical key on parse so downstream code only sees the new name. Will be removed in a future release.
