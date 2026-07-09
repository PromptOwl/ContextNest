# @promptowl/contextnest-governance

**Proprietary governance layer for Context Nest** — stewardship RBAC, user-level read/commit policy, and a provenance/audit store, implementing the open engine's identity-agnostic `GovernanceHooks` / `ProvenanceRecorder` seams.

> **License:** Commercial, source-available — see [LICENSE.md](LICENSE.md) and the repository-root [NOTICE](../../NOTICE). This package is **not** open source, is **never published to npm**, and its production use requires a commercial agreement with [PromptOwl](https://promptowl.ai) (<hello@promptowl.ai>). Everything else in this repository is AGPL-3.0.

## What it provides

- **Stewardship RBAC** — per-user × per-nest × per-scope roles. Nest-wide grants live in `nest_collaborators` (`read` / `write` / `admin`); scoped governance roles live in `stewards` (`editor` / `reviewer` / `admin` at `document` > `tag` > `nest` resolution priority). A user's effective rights are the union of collaborator and steward rows (`resolveUserRoles`, `canUserEdit`, `canUserApprove`, `canUserAccess`, `canCreateInNest`).
- **User-level read and commit limits** — `canReadNode` / `filterAccessible` gate reads; the engine bridge maps `create → canCreateInNest`, `update/delete/stage_suggestion → canUserEdit`, `publish → canUserEdit OR canUserApprove`.
- **Provenance store** — every gated engine event (publishes, queries, governance actions, chain events) is mirrored into an `api_events` SQLite table (`trace-log.ts`, 14-day rolling retention) with actor email and origin (`client`/`tool`).
- **Server access policy** — `access.yaml` support (`isEmailAllowed` with `*.domain` wildcards, group default permissions, `super_admins`).
- **Storage** — self-contained SQLite (better-sqlite3, WAL); `openGovernanceDb(path)` bootstraps the schema idempotently. Identity is the caller-supplied email string — no user/session tables, no license or SSO coupling.

## Wiring it into a deployment

The open engine, CLI, and MCP server never reference this package. They discover it at runtime through the engine's governance-module loader:

```bash
# Point any ctx / MCP deployment at this package's build:
export CONTEXTNEST_GOVERNANCE_MODULE=/path/to/packages/governance/dist/index.js
export CONTEXTNEST_GOVERNANCE_DB=/var/lib/contextnest/governance.db   # default: <vault>/.context/governance.db
export CONTEXTNEST_GOVERNANCE_NEST_ID=default
export CONTEXTNEST_ACTOR=you@company.com                              # CLI also accepts --actor
```

Or per vault, in `.context/config.yaml`:

```yaml
governance:
  module: /path/to/packages/governance/dist/index.js
```

Seed grants with the admin API:

```ts
import {
  openGovernanceDb, setNestOwner, setStewardshipEnabled,
  addCollaborator, addSteward,
} from "@promptowl/contextnest-governance";

const db = openGovernanceDb("/var/lib/contextnest/governance.db");
setNestOwner(db, "default", "owner@company.com");
setStewardshipEnabled(db, "default", true);
addCollaborator(db, "default", "editor@company.com", "write");
addCollaborator(db, "default", "viewer@company.com", "read");
addSteward(db, "default", { scope: "tag", tagName: "finance", email: "cfo@company.com", role: "reviewer" });
```

From then on the compiled `ctx` CLI and the MCP server enforce policy on every read, query, write, publish, delete, and drift-approval — a `read` collaborator can read and query published knowledge but every mutation exits with `Unauthorized`; unknown actors are denied entirely; and every commit is attributed in both the engine's hash-chained history (`origin`) and this package's `api_events` audit table.

## Consuming from another repo (no npm)

This package is intentionally unpublished. The private ContextNest Community server consumes it as a git dependency:

```bash
pnpm add "github:PromptOwl/ContextNest#path:packages/governance"
```

## Development

```bash
pnpm --filter @promptowl/contextnest-governance build   # tsup → dist/
pnpm --filter @promptowl/contextnest-governance test    # unit + bridge tests
pnpm --filter @promptowl/contextnest-governance lint    # tsc --noEmit
```

The end-to-end proof lives in `src/__tests__/cli-real-package.regression.test.ts` (run via `pnpm test:regression` at the repo root): two users drive the real compiled CLI against this package's built dist with a seeded stewardship DB.

Provenance of this code: ported (2026-07) from the private `contextnest-community` server's `src/governance/*`, `src/shared/access.ts`, and `src/telemetry/trace-log.ts`, decoupled from that server's HTTP, auth, and licensing layers.
