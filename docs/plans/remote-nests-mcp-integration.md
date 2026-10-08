# Plan: Multi-MCP Integration — Local and Remote Nests Through the `ctx` CLI

Status: proposed
Owner: —
Related: `CONTEXT_NEST_SPEC.md` §1.9 (source nodes), §5 (`context.yaml`), `packages/mcp-server/`

## 1. Problem and Goal

Today the `ctx` CLI (and therefore the coding-agent plugins, which shell out to
`ctx`) can only operate on **local** vaults — directories on disk resolved via
the vault registry (`~/.contextnest/config.yaml`). A nest served elsewhere — a
hosted ContextNest, a teammate's machine, a CI-published knowledge base — is
unreachable except through the one-way `ctx push` command.

**Goal:** let users register any number of MCP-served nests (local *or* remote)
in the ContextNest config files, and make `ctx` transparently route commands to
them. Because the plugins already do everything through `ctx --vault <alias>`,
they inherit local + remote nest support with almost no plugin changes: the CLI
is the single integration point.

```
                       ┌────────────────────────────────────┐
  Claude Code plugin   │              ctx CLI               │
  (hooks shell out) ──▶│  resolveNest(alias)                │
                       │   ├─ local  → engine (NestStorage) │
                       │   └─ remote → MCP client ──────────┼──▶ ContextNest MCP server
                       └────────────────────────────────────┘     (stdio or HTTP,
                                                                   local or hosted)
```

## 2. Key Design Decision: the Operation Catalog over MCP as the Remote Protocol

The engine already ships the **canonical operation catalog**
(`packages/engine/src/api/` — "API Convergence Phase 1"): 16 transport-agnostic
`context_*` operations (`context_get`, `context_query`, `context_search`,
`context_create`, …) with Zod input/output schemas, JSON Schema generation, an
executable runtime (`createEngineApi().run(name, input, ctx)`), legacy-alias
lookup (the OSS MCP names `read_document`/`resolve`/… are recorded as
`aliases`), and namespace discovery (`core` / `governance` / `workflow` /
`sync`). Its own roadmap ends at exactly this feature: *"Phase 4 — one `ctx`
CLI with `local` and `remote` backends."*

**Current state (important):** the catalog is *not yet wired in*. The MCP
server's 19 tools and the CLI still hand-write their schemas inline — two
sources of truth, with the catalog intended to win (its Phase 2).

So the remote protocol is not "the 19 legacy tool names" — it is **the catalog,
exposed over MCP**:

- The wire contract is the canonical `context_*` operation names with
  catalog-generated schemas; the legacy tool names remain available as
  deprecated aliases via the catalog's alias table (the PRD's 2-release
  migration window).
- The CLI gains an **MCP client** that maps catalog operations onto MCP tool
  calls. Any endpoint exposing the catalog's `core` namespace is a valid
  remote nest — our own server over stdio, the same server behind an HTTP
  gateway, or a hosted ContextNest implementation.
- The catalog's `NAMESPACES` discovery (advertised via MCP `initialize` /
  server capabilities) tells the client which surfaces a given remote actually
  implements — e.g. a remote with `core` but no `governance` cleanly rejects
  `ctx drift` instead of failing mid-call.
- No second wire protocol to design, document, or keep in sync; the catalog's
  conformance suite (its Phase 3) doubles as the protocol conformance suite.

This makes **API Convergence Phase 2 (bind the MCP server + CLI to the
catalog) a prerequisite** of this plan rather than a parallel effort — see the
delivery phases in §8.

## 3. Configuration Model

### 3.1 Registry: a new `remotes:` map (backward compatible)

`~/.contextnest/config.yaml` grows a sibling to `vaults:`:

```yaml
version: 1
default: work
vaults:                      # unchanged — local vaults
  work:
    path: /home/q/work-vault
remotes:                     # NEW — MCP-served nests
  team:
    transport: http
    url: https://nest.example.com/mcp
    auth:
      bearer_env: CONTEXTNEST_TEAM_TOKEN   # env-var reference, never a raw secret
    description: Team shared nest
  research:
    transport: stdio
    command: npx
    args: ["-y", "@promptowl/contextnest-mcp-server", "/srv/research-vault"]
    description: Research vault served by our own MCP server
```

Why a *separate* top-level key instead of extending `vaults:` entries:

- The current Zod schema (`registry.ts`) requires `path` on every `vaults`
  entry and **strips unknown top-level keys**. An older CLI reading a new
  registry simply doesn't see `remotes:` — no parse failure, no version bump,
  no migration. Extending `vaults` entries would make old CLIs hard-fail on
  the whole registry.
- Local and remote entries have genuinely different shapes and validation
  (path-must-exist vs URL/command).

Rules:

- **One alias namespace.** An alias may exist in `vaults` OR `remotes`, never
  both — enforced on write and validated on read. `--vault <alias>`,
  `CONTEXTNEST_VAULT`, registry `default:`, and the plugin's pinned vault all
  keep working unchanged, whichever kind the alias names.
- Same `ALIAS_PATTERN` as today (shell-safe, YAML-safe).
- `auth` supports `bearer_env` (recommended) and `header_env` for custom
  header schemes. Raw secrets in the file are rejected by the schema —
  the registry is 0600 but secrets belong in env/keychain.
- Credentials over cleartext `http://` are rejected by the schema (on write
  AND read) unless the host is loopback (`localhost`/`127.x`) — a bearer
  token on an unencrypted wire is a leak, not a configuration choice.
- Optional per-remote `timeout_ms` (default 10 000).

### 3.2 Vault-local config (`.context/config.yaml`)

The spec (§5) already reserves a `sources:` record of
`{url, transport, description}` used by `source` nodes (`transport: mcp` is one
of `TRANSPORTS`). This plan does **not** repurpose that: vault-local `sources:`
remain the registration point for *live data sources referenced by source
nodes*; the registry `remotes:` map is for *whole nests addressed as vaults*.
Both will share the same MCP client module (see §4), so source-node MCP
hydration becomes a cheap follow-up (§9).

## 4. Engine Changes (`@promptowl/contextnest-engine`)

### 4.1 `resolveNest()` — generalized resolution

`resolveVaultPath()` currently returns a filesystem path. Add:

```ts
type ResolvedNest =
  | { kind: "local";  path: string;  source: VaultResolutionSource; alias?: string; warning?: string }
  | { kind: "remote"; remote: RemoteNestSpec; source: ...;          alias:  string; warning?: string };

export function resolveNest(opts: ResolveVaultOptions): ResolvedNest;
```

Precedence order is unchanged; steps 1, 2, 4, and 6 (flag / env alias /
positional arg / default) can now land on a `remotes` entry. Steps 3, 5, 7
(env path / local walk-up / cwd) are inherently local.

`resolveVaultPath()` stays as a thin wrapper that throws a clear
`ConfigError` ("alias `team` is a remote nest — this operation requires a
local vault") when resolution lands on a remote. Every existing caller keeps
compiling and behaving identically for local aliases.

### 4.2 Backends for the operation catalog — not a new interface

There is **no new bespoke `NestClient` interface to design**: the catalog's
runtime shape *is* the interface. Both backends expose the same call:

```ts
interface ApiBackend {
  run(name: string, input: unknown, ctx: OperationContext): Promise<unknown>;
  namespaces(): Promise<CapabilityNamespace[]>;  // what this nest implements
  close(): Promise<void>;
}
```

- **Local backend** — `createEngineApi()` already exists and is tested
  (`api/runtime.ts`, `api/core-executors.ts`). The "extract shared glue from
  CLI actions and MCP handlers" work is already done there; the CLI just needs
  to migrate onto it (API Convergence Phase 2).
- **Remote backend** — wraps an MCP SDK `Client`; `run(name, input)` becomes
  `callTool({ name, arguments: input })`, with results validated against the
  catalog's *output* Zod schemas and MCP `isError` payloads mapped back to the
  catalog's typed `ErrorCode`s (`api/types.ts`) so the CLI renders local and
  remote failures identically. Operations are looked up via `getOperation()`
  (which resolves legacy aliases too), so the client can talk to both
  catalog-native servers and pre-migration servers exposing only the old
  19-tool names. Transports:
  - `stdio`: `StdioClientTransport` with `command` + `args` array (never a
    shell string — Windows correctness, and no shell-injection surface).
  - `http`: `StreamableHTTPClientTransport` with auth headers resolved from
    the referenced env vars at call time.
- **Capability gating:** `namespaces()` reads the advertised namespace set;
  `governance`, `workflow`, and `sync` are declared-but-unpopulated in the
  catalog today (`implemented: false`), so remote governance commands
  (`ctx drift …`) fail fast with `NOT_IMPLEMENTED` until those namespaces land
  rather than being frozen into the v1 wire contract.

**Dependency note:** `@modelcontextprotocol/sdk` becomes a dependency of the
engine (or of a small new `packages/mcp-client` package if we want the engine
to stay dependency-light — decide at implementation time; the interface is the
same either way. Recommendation: start inside the engine behind a lazy dynamic
`import()` so `ctx` invocations that never touch a remote pay zero startup
cost, and split out later only if needed).

### 4.3 Registry additions

- `remoteNestSpecSchema` (discriminated union on `transport`).
- `addRemote(alias, spec, opts)`, `removeVault`/`listVaults` extended to cover
  remotes; `listVaults()` entries gain `kind: "local" | "remote"` and, for
  remotes, `reachable?: boolean` populated only when explicitly probed
  (`ctx vault list --check`) — never implicitly, so `vault list` stays fast
  and offline-safe.
- Cross-namespace uniqueness enforced in `addVault` + `addRemote`.

## 5. CLI Changes (`@promptowl/contextnest-cli`)

### 5.1 Registration UX

```bash
# HTTP remote
ctx vault add team --url https://nest.example.com/mcp --bearer-env CONTEXTNEST_TEAM_TOKEN

# stdio remote (self-hosted MCP server, another machine via ssh wrapper, etc.)
ctx vault add research --mcp-command npx --mcp-arg -y --mcp-arg @promptowl/contextnest-mcp-server --mcp-arg /srv/research-vault

ctx vault list            # kind column: local | remote; --check probes reachability
ctx vault which           # shows kind + endpoint for remote resolution
ctx vault remove team     # works for both kinds
ctx vault default team    # a remote may be the default
```

(`ctx vault add <alias> [path]` with a path stays exactly as-is for local.)

### 5.2 Command routing

Replace `getStorage()` call sites with `getNest(): Promise<ApiBackend>` and
route command actions through catalog operations (this is simultaneously the
CLI half of API Convergence Phase 2):

- **Remote-capable (Phase A — read/query surface):** `query`, `search`,
  `resolve`, `list`, `read`, `pack list/show`, `verify`, `history`,
  `checkpoint list`, `vault which/list`. This is the entire retrieval surface
  the plugin's `SessionStart`/`UserPromptSubmit` hooks use.
- **Remote-capable (Phase B — write/governance surface):** `add`, `update`,
  `delete`, `publish`, `drift stage/list/approve/reject`. This is what the
  plugin's auto-capture (`Stop` hook) needs.
- **Local-only (always):** `init`, `index`, `validate`, `reconstruct`,
  `checkpoint rebuild`, `welcome`, `push`. These touch the filesystem or
  regenerate local artifacts; on a remote alias they fail fast with the
  `ConfigError` from §4.1 — a one-line, actionable message.

All remote calls honor the per-remote timeout and print
`(remote: <alias> via <transport>)` in human output; `--json` output shapes are
**identical** for local and remote — that invariant is what keeps the plugins
and any other `ctx` scripting unchanged.

### 5.3 Exit codes / offline behavior

Remote connection failures exit with a distinct code (e.g. `3`) and a
`stderr` line naming the alias and endpoint, so plugin hooks can distinguish
"remote unreachable" (skip silently) from "bad query" (surface).

## 6. Plugin Changes (`plugins/shared/`)

Deliberately minimal — the CLI does the heavy lifting:

- `lib.js listVaults()` already consumes `vault list --json`; pass through the
  new `kind` field.
- `vaultTargets()`: fan-out now naturally includes remote aliases. Add a small
  latency guard: remotes participate in fan-out only up to the existing
  `MAX_FANOUT_VAULTS` cap, and hook-level `exec` calls against remote aliases
  get a hard timeout (hooks must never hang a session — reuse the CLI's
  timeout, plus `execFileSync`'s `timeout` option as a belt-and-braces).
- `session-start.js`: overview line annotates remote nests
  (`team (remote) — Team shared nest`), and a stale/unreachable remote warns
  once instead of failing the hook.
- Capture gate (`Stop` hook): honors Phase B availability — if the pinned
  vault is remote and writes aren't enabled yet (Phase A shipped alone),
  capture no-ops with a debug line rather than erroring.
- Run `pnpm plugins:sync` after edits; CI `plugins:check` guards drift.

## 7. Testing Strategy

- **Unit (engine):** registry round-trip with `remotes:` (old-schema file still
  parses; new file read by the *old* schema shape parses too — assert via a
  frozen copy of the v-current schema); alias-collision rules; `resolveNest`
  precedence including remote default / remote env alias; the remote backend
  against the MCP SDK's `InMemoryTransport` linked pair with a stub server —
  no subprocess, runs in `pnpm test`. Catalog conformance (its Phase 3): no
  inline `inputSchema` literals left in mcp-server/CLI.
- **Regression:** the killer fixture is already in-repo — spawn the **built**
  `contextnest-mcp` (`dist/index.js`) over stdio against a throwaway vault and
  point the remote backend at it; then drive the **built** `ctx` with a
  registry whose `remotes:` entry uses that stdio command. Asserts CLI ↔
  server contract end-to-end, cross-platform (ubuntu/windows/macos × Node
  20/22 — argv arrays only, CRLF-safe assertions).
- **Plugin tests:** fake `exec` returning `vault list --json` with mixed
  kinds; assert fan-out, capture gating, and session-start annotations.

## 8. Delivery Phases

| Phase | Scope | Ships value |
|-------|-------|-------------|
| 1 | Registry `remotes:` schema + `resolveNest()` + `ctx vault add/list/remove/which/default` for remotes (no command routing yet) | Registration UX; foundation |
| 2 | **API Convergence Phase 2**: MCP server + CLI bind to the operation catalog (`context_*` canonical names, legacy tool names as deprecated aliases); delete inline schemas | Single schema source; the wire contract exists |
| 3 | Remote `ApiBackend` (stdio + HTTP) with timeouts/auth/capability gating, unit-tested via `InMemoryTransport` | Protocol layer |
| 3b | CLI routing for the read/query surface (§5.2 Phase A) + exit-code contract | Plugins retrieve from remote nests |
| 4 | Write surface (§5.2 Phase B: `context_create/update/publish/delete/import`); governance ops follow once the catalog's `governance` namespace is populated | Auto-capture into remote nests |
| 5 | Plugin polish (§6), regression suites, docs: README, `CONTEXT_NEST_SPEC.md` addendum (registry `remotes:` shape + remote command matrix), changeset (minor, all three packages) | GA |

Phases 1–3b are the MVP the plugin story needs; 4–5 complete the loop.
Phase 2 is a standalone, independently valuable refactor (it was already the
catalog's own roadmap) and can land in parallel with Phase 1.

## 9. Follow-ups (explicitly out of scope here)

- **Source-node hydration:** reuse the remote backend's transport layer to call
  arbitrary (non-ContextNest) MCP servers declared in vault-local `sources:`
  for `source` node refresh (`transport: mcp`, spec §1.9.4) — the multi-MCP
  story beyond nests.
- **Response caching** for HTTP remotes (etag/short-TTL) if hook latency needs it.
- **`ctx push` convergence:** re-express push as `context_import` (bulk
  create+publish, one checkpoint) against a remote alias, retiring the bespoke
  REST payload.
- **Keychain-backed auth** as an alternative to env-var references.

## 10. Open Questions

1. Transport priority: ship stdio + HTTP together (recommended — stdio is
   nearly free once the client exists and is what self-hosters use), or HTTP
   only first?
2. Should a remote alias be allowed as registry `default:`? Plan says yes;
   flag if hosted-latency-by-default feels wrong.
3. Engine dependency vs. new `packages/mcp-client` package (§4.2 note) —
   leaning engine-internal with lazy import.
