# Engineering Review: Native ContextNest Antigravity Plugin

**Prepared for:** PromptOwl Engineering Team (ContextNest Engine & Integrations)  
**Author:** Stacey & Pair-Programming Assistant  
**Date:** October 15, 2026  
**Status:** Proposal & Working Implementation Ready for Review  
**Target Repository Location:** `ContextNest-repo/plugins/antigravity/` (or replacing `plugins/gemini/`)

---

## 1. Executive Summary & Intent

ContextNest currently ships a production Claude Code plugin (`@promptowl/contextnest-claude-plugin` at `plugins/claude-code/`), backed by agent-agnostic core libraries in `plugins/shared/core/`. 

In `plugins/gemini/README.md`, an adapter for Gemini / Antigravity was noted as planned ("scaffold only"). With Antigravity 2.0 and the Antigravity IDE being actively used across our engineering and marketing workflows, we have implemented the full native **Antigravity Customization Plugin**.

This implementation achieves **100% architectural parity** with the Claude Code plugin while adhering to Antigravity's native customization and lifecycle hook protocols.

---

## 2. Architectural Comparison: Claude Code vs. Antigravity

| Feature / Hook | Claude Code Plugin (`plugins/claude-code`) | Antigravity Native Plugin (`plugins/antigravity`) | Mechanism & Parity Notes |
|---|---|---|---|
| **Plugin Manifest** | `.claude-plugin/plugin.json` | `plugin.json` | Standard Antigravity plugin manifest with keywords, author, and version. |
| **MCP Integration** | External config or rules injection | `mcp_config.json` | Native Antigravity MCP declaration: declares `ctx mcp-server` so tools are auto-discovered without manual Claude desktop config. |
| **Session Priming** | `SessionStart` hook (`session-start.js`) | `PreInvocation` hook (`core/pre-invocation.js`) | Injects vault overview + **Structure Rules** (`ctx structure --json`) on `invocationNum === 1`. |
| **Auto-Retrieval** | `UserPromptSubmit` hook (`retrieve.js`) | `PreInvocation` hook (`core/pre-invocation.js`) | Reads latest prompt from transcript, runs effort-toggled retrieval (`search`/`query`/`agent`), injects as ephemeral message. |
| **Stale Sweep** | `PostToolUse` (matcher: `Bash`) | `PostToolUse` (matcher: `run_command`) | Inspects tool call args for `ctx update`; runs `sweep-check.js` to detect cross-vault drift. |
| **Turn End Capture** | `Stop` hook (`capture-gate.js`) | `Stop` hook (`core/stop-gate.js`) | Evaluates capture ladder at turn end; parks jobs in `~/.contextnest/plugin-state/` for subsequent prompt dispatch. |
| **Manual Commands** | Custom markdown commands (`commands/capture.md`) | Antigravity Skills (`skills/contextnest-*/SKILL.md`) | Four progressive skills: `contextnest-recall`, `contextnest-capture`, `contextnest-curate`, `contextnest-structure`. |
| **Governed Rules** | System prompt instructions | `rules/contextnest.md` | Workspace rule instructing the agent on query-before-answering, citation syntax, structure rules, and review gates. |

---

## 3. Key Design Decisions

1. **Zero Modifications to Shared Core:**
   - The plugin consumes `plugins/shared/core/` (`lib.js`, `signals.js`, `ledger.js`, `session-start.js`, `retrieve.js`, `capture-gate.js`, `sweep-check.js`) unmodified.
   - Thin adapters (`pre-invocation.js`, `post-tool-use.js`, `stop-gate.js`) translate Antigravity stdin/stdout contracts into calls to the shared core functions.

2. **Antigravity JSON Protocol Adherence:**
   - PreInvocation outputs `{ "injectSteps": [ { "ephemeralMessage": "..." } ] }`.
   - PostToolUse and Stop safely return `{}` without halting the agent loop unless a hard stop block is triggered.

3. **Built-in Support for 2.0 Capabilities:**
   - Automatically surfaces **Structure Rules** on session start (`ctx structure --json`).
   - Understands **Review Gates** (`Held for review: ctx review approve <id>`).
   - Supports multi-nest addressing (`<server>/<nest>`).

---

## 4. Test Verification

The plugin includes a self-contained test suite at `tests/adapter.test.mjs`:

```bash
$ node tests/adapter.test.mjs
Testing ContextNest Antigravity plugin adapters...
✔ pre-invocation adapter returned valid JSON: [ 'injectSteps' ]
✔ post-tool-use adapter returned valid {} response
✔ stop-gate adapter returned valid {} response

All adapter tests passed successfully!
```

---

## 5. Recommended Next Steps for Engineering

1. **Review and Vendor into Monorepo:**
   - Copy this folder into `ContextNest-repo/plugins/antigravity/` (or update `plugins/gemini/`).
   - Update `pnpm plugins:sync` script in the repo root to include `plugins/antigravity` alongside `plugins/claude-code`.
2. **NPM Distribution:**
   - Optionally publish as `@promptowl/contextnest-antigravity-plugin` or include in the global Antigravity plugin registry (`~/.gemini/config/plugins/`).
