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

## 2. Key Design Decision: MCP as the Remote Nest Protocol

We already ship an MCP server (`@promptowl/contextnest-mcp-server`) exposing 19
tools (`vault_info`, `resolve`, `search`, `query`-equivalents, document CRUD,
drift workflow, …). That tool contract **is** the remote protocol:

- The CLI gains an **MCP client** that maps `ctx` subcommands onto those same
  tool names.
- Any endpoint speaking that tool contract is a valid remote nest — our own
  server over stdio, the same server behind an HTTP gateway, or a hosted
  ContextNest implementation.
- No second wire protocol to design, document, or keep in sync; the MCP server
  test suite doubles as the protocol conformance suite.

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

### 4.2 `NestClient` — one interface, two implementations

New module `nest-client.ts` defining the operation surface the CLI needs,
named after the MCP tool contract:

```ts
interface NestClient {
  vaultInfo(): Promise<VaultInfo>;
  resolve(selector: string): Promise<ResolveResult>;
  query(selector: string, opts): Promise<QueryResult>;
  search(q: string, opts): Promise<SearchResult>;
  listDocuments(filter): Promise<...>;
  readDocument(path: string, opts): Promise<...>;
  readIndex(): Promise<...>;
  readPack(name: string): Promise<...>;
  verifyIntegrity(): Promise<...>;
  listCheckpoints(): Promise<...>;
  readVersion(path: string, v: number): Promise<...>;
  createDocument(...): Promise<...>;    // write surface
  updateDocument(...): Promise<...>;
  deleteDocument(...): Promise<...>;
  publishDocument(...): Promise<...>;
  stageDriftSuggestion(...): Promise<...>;  // governance surface
  listSuggestions(...): Promise<...>;
  approveSuggestion(...): Promise<...>;
  rejectSuggestion(...): Promise<...>;
  close(): Promise<void>;
}
```

- **`LocalNestClient`** wraps today's engine calls (`NestStorage`, selector
  evaluator, etc.). Mostly mechanical extraction of logic that currently lives
  inline in CLI command actions and in the MCP server's tool handlers — which
  also deduplicates those two surfaces (they reimplement the same glue today).
- **`RemoteNestClient`** wraps an MCP SDK `Client` and calls the corresponding
  tools by name, parsing their JSON payloads with Zod schemas. Transports:
  - `stdio`: `StdioClientTransport` with `command` + `args` array (never a
    shell string — Windows correctness, and no shell-injection surface).
  - `http`: `StreamableHTTPClientTransport` with auth headers resolved from
    the referenced env vars at call time.
- Both structured results and error mapping (`isError` tool results → typed
  engine errors) live behind the interface so the CLI renders local and remote
  failures the same way.

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

Replace `getStorage()` call sites with `getNest(): Promise<NestClient>`:

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
  precedence including remote default / remote env alias; `RemoteNestClient`
  against the MCP SDK's `InMemoryTransport` linked pair with a stub server —
  no subprocess, runs in `pnpm test`.
- **Regression:** the killer fixture is already in-repo — spawn the **built**
  `contextnest-mcp` (`dist/index.js`) over stdio against a throwaway vault and
  point `RemoteNestClient` at it; then drive the **built** `ctx` with a
  registry whose `remotes:` entry uses that stdio command. Asserts CLI ↔
  server contract end-to-end, cross-platform (ubuntu/windows/macos × Node
  20/22 — argv arrays only, CRLF-safe assertions).
- **Plugin tests:** fake `exec` returning `vault list --json` with mixed
  kinds; assert fan-out, capture gating, and session-start annotations.

## 8. Delivery Phases

| Phase | Scope | Ships value |
|-------|-------|-------------|
| 1 | Registry `remotes:` schema + `resolveNest()` + `ctx vault add/list/remove/which/default` for remotes (no command routing yet) | Registration UX; foundation |
| 2 | `NestClient` interface + `LocalNestClient` extraction + `RemoteNestClient` (stdio + HTTP) with timeouts/auth | Protocol layer, unit-tested |
| 3 | CLI routing for the read/query surface (§5.2 Phase A) + exit-code contract | Plugins retrieve from remote nests |
| 4 | Write/governance surface (§5.2 Phase B) | Auto-capture into remote nests |
| 5 | Plugin polish (§6), regression suites, docs: README, `CONTEXT_NEST_SPEC.md` addendum (registry `remotes:` shape + remote command matrix), changeset (minor, all three packages) | GA |

Phases 1–3 are the MVP the plugin story needs; 4–5 complete the loop.

## 9. Follow-ups (explicitly out of scope here)

- **Source-node hydration:** reuse `RemoteNestClient`'s transport layer to call
  arbitrary (non-ContextNest) MCP servers declared in vault-local `sources:`
  for `source` node refresh (`transport: mcp`, spec §1.9.4) — the multi-MCP
  story beyond nests.
- **Response caching** for HTTP remotes (etag/short-TTL) if hook latency needs it.
- **`ctx push` convergence:** re-express push as `publish_document` calls
  against a remote alias, retiring the bespoke REST payload.
- **Keychain-backed auth** as an alternative to env-var references.

## 10. Open Questions

1. Transport priority: ship stdio + HTTP together (recommended — stdio is
   nearly free once the client exists and is what self-hosters use), or HTTP
   only first?
2. Should a remote alias be allowed as registry `default:`? Plan says yes;
   flag if hosted-latency-by-default feels wrong.
3. Engine dependency vs. new `packages/mcp-client` package (§4.2 note) —
   leaning engine-internal with lazy import.
