# Context Nest — Gemini CLI & Google Antigravity Adapter

> **Status:** **Built.** Adapter for Google Antigravity (CLI, IDE, App), written against the [Antigravity hooks contract](https://antigravity.google/docs/hooks). Unit-tested with a fake `ctx`; validate in a live Antigravity session before relying on it. `node` must be on `PATH`.

Makes any Antigravity or Gemini session **vault-aware** (effort-toggled auto-retrieval) and **self-maintaining** (governed knowledge capture), driving the standard [`ctx`](../../packages/cli) CLI directly without extra MCP setup.

---

## Capabilities

1. **Automatic Session Orientation (`SessionStart`):**
   - On session start, injects a compact vault overview, registered aliases, and enforced **Structure Rules** (`ctx structure --json`).
2. **Effort-Toggled Retrieval (`PreInvocation`):**
   - Searches and injects relevant vault context when the newest transcript record is the user's prompt, so once per prompt rather than once per model call. Later model calls in the turn only hand over parked work. Respects `CONTEXTNEST_RETRIEVAL_MODE` (`off` · `search` · `query` · `agent`).
3. **Stale Reference Sweeping (`PostToolUse`):**
   - When vault nodes are updated via `run_command` (`ctx update`), scans every registered vault for nodes still holding the removed fact. `PostToolUse` cannot inject output, so the report is parked and delivered by the next `PreInvocation`.
4. **End-of-Turn Capture Gating (`Stop`):**
   - Evaluates whether new decisions or architectural solutions occurred during the turn, parking capture jobs into the session ledger (`~/.contextnest/plugin-state/`); the next prompt's `PreInvocation` hands them over. Explicit asks ("remember this") and corrections always gate; the ambient heuristic depends on transcript record types Antigravity does not document yet.
5. **Workspace Skills (`skills/`):**
   - `contextnest-recall`: Deep graph traversal and citation (`ctx query` / `ctx search`).
   - `contextnest-capture`: Governed knowledge capture adhering to structure rules.
   - `contextnest-curate`: Multi-vault fact updates, entity tag sweeps, and refiling.
   - `contextnest-structure`: Inspection of folder taxonomies and template scaffolding.
6. **Operating Rules (`rules/contextnest.md`):**
   - Automatic guidance loaded by Antigravity covering vault citation rules (`vault:id`), review SLA escalation ladders, and edit-and-approve safeguards.

---

## Directory Layout

```text
plugins/gemini/
├── plugin.json                    # Antigravity & Gemini plugin manifest
├── package.json                   # ESM module package spec
├── hooks.json                     # Antigravity hooks (SessionStart, PreInvocation, PostToolUse, Stop)
├── hooks/
│   └── antigravity.js             # Adapter: Antigravity hook contract → shared core
├── core/                          # Vendored copy of plugins/shared/core — never edit; run `pnpm plugins:sync`
├── rules/
│   └── contextnest.md             # Antigravity operating rules & citation guidelines
└── skills/
    ├── contextnest-recall/        # Deep vault retrieval skill
    ├── contextnest-capture/       # Governed capture skill
    ├── contextnest-curate/        # Vault fact curation skill
    └── contextnest-structure/     # Structure rules inspection skill
```

---

## Configuration

The adapter respects the standard ContextNest environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXTNEST_RETRIEVAL_MODE` | `search` | Auto-retrieval effort: `off` \| `search` \| `query` \| `agent` |
| `CONTEXTNEST_CAPTURE_MODE` | `explicit` | Capture policy: `off` \| `explicit` \| `propose` \| `auto` |
| `CONTEXTNEST_VAULT_ALIAS` | _(none)_ | Pinned vault alias (note: `_ALIAS`, not `CONTEXTNEST_VAULT`, which the CLI reads) |
| `CONTEXTNEST_UNCLEAR_NEST` | `ask` | When no nest clearly fits a new note: `ask` \| `default` |
| `CONTEXTNEST_CTX_COMMAND` | `ctx` | Path or name of the ContextNest CLI binary |

---

## Verification

The adapter tests run with the plugin suite (`plugins/__tests__/gemini-adapter.test.ts`):

```bash
pnpm test plugins/__tests__/gemini-adapter.test.ts
pnpm plugins:check
```
