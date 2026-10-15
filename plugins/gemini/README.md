# Context Nest — Gemini CLI & Google Antigravity Adapter

> **Status:** **Built & Tested.** Drop-in adapter for Google Antigravity (AGY CLI, Antigravity IDE, Antigravity 2.0) and the Gemini CLI extension ecosystem. Supersedes previous scaffolding.

Makes any Antigravity or Gemini session **vault-aware** (effort-toggled auto-retrieval) and **self-maintaining** (governed knowledge capture), driving the standard [`ctx`](../../packages/cli) CLI directly without extra MCP setup.

---

## Capabilities

1. **Automatic Session Orientation (`PreInvocation`):**
   - On session startup (`invocationNum: 1`), injects a compact vault overview, registered aliases, and enforced **Structure Rules** (`ctx structure --json`).
2. **Effort-Toggled Retrieval (`PreInvocation`):**
   - Automatically searches and injects relevant vault context for each user prompt before the model responds. Respects `CONTEXTNEST_RETRIEVAL_MODE` (`off` · `search` · `query` · `agent`).
3. **Stale Reference Sweeping (`PostToolUse`):**
   - When vault nodes are updated via `run_command` (`ctx update`), scans other registered vaults for straggler documents holding the removed fact.
4. **End-of-Turn Capture Gating (`Stop`):**
   - Evaluates whether new decisions or architectural solutions occurred during the turn, parking capture jobs into the session ledger (`~/.contextnest/plugin-state/`).
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
├── package.json                   # ESM module package spec & test runner
├── hooks.json                     # Antigravity lifecycle hooks (PreInvocation, PostToolUse, Stop)
├── core/                          # Vendored shared core + Antigravity adapters
│   ├── lib.js                     # Shared IO shell & ctx execution wrapper
│   ├── retrieve.js                # Auto-retrieval engine
│   ├── session-start.js           # Session priming & structure rules loader
│   ├── capture-gate.js            # Capture ladder gate
│   ├── sweep-check.js             # Post-update stale node detector
│   ├── pre-invocation.js          # Antigravity PreInvocation hook adapter
│   ├── post-tool-use.js           # Antigravity PostToolUse hook adapter
│   └── stop-gate.js               # Antigravity Stop hook adapter
├── rules/
│   └── contextnest.md             # Antigravity operating rules & citation guidelines
├── skills/
│   ├── contextnest-recall/        # Deep vault retrieval skill
│   ├── contextnest-capture/       # Governed capture skill
│   ├── contextnest-curate/        # Vault fact curation skill
│   └── contextnest-structure/     # Structure rules inspection skill
└── tests/
    └── adapter.test.mjs           # Unit test suite verifying hook JSON contracts
```

---

## Configuration

The adapter respects the standard ContextNest environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXTNEST_RETRIEVAL_MODE` | `search` | Auto-retrieval effort: `off` \| `search` \| `query` \| `agent` |
| `CONTEXTNEST_CAPTURE_MODE` | `propose` | Capture policy: `off` \| `propose` \| `auto` |
| `CONTEXTNEST_VAULT_ALIAS` | _(none)_ | Pinned vault alias to target by default |
| `CONTEXTNEST_CTX_COMMAND` | `ctx` | Path or name of the ContextNest CLI binary |

---

## Verification

Run the included adapter test suite:

```bash
cd plugins/gemini
npm test
```
