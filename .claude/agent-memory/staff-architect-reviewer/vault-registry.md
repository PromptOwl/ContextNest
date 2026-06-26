---
name: vault-registry
description: Central vault registry (engine/src/registry.ts) — alias→path mapping, resolveVaultPath precedence, atomic write, security model
metadata:
  type: project
---

Central vault registry feature: maps short aliases → vault paths so CLI/MCP can target any vault from any cwd (AWS-named-profiles analogy). Registry only stores paths; vaults never relocated.

Lives at `~/.contextnest/config.yaml` (override with `CONTEXTNEST_CONFIG_DIR`). Core in `packages/engine/src/registry.ts`, exported via engine `index.ts`. Consumed by `packages/cli/src/index.ts` (`getVaultRoot`, `ctx vault` subcommands, init auto-registration) and `packages/mcp-server/src/index.ts` (`resolveMcpVaultPath`).

**resolveVaultPath precedence** (1 highest): (1) `--vault` flag → throws on bad alias; (2) `CONTEXTNEST_VAULT` env alias → warns+falls through if stale (must not lock user out); (3) `CONTEXTNEST_VAULT_PATH` env path → used directly, NOT validated; (4) local vault walk-up; (5) registry `default` alias → soft fallback, won't throw; (6) cwd.

**Security/robustness conventions established here:**
- Registry dir 0o700, file 0o600 (owner-only; avoids leaking FS topology on shared hosts). No-op on Windows.
- Atomic write: temp `${target}.${pid}.tmp` + rename; copy fallback ONLY on Windows EPERM; temp cleaned in finally.
- Alias charset `ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/` (exported single source of truth; CLI prompt reuses it).
- `UnknownAliasError extends ConfigError` — subtype so MCP can distinguish "not an alias → treat as path" from "stale alias → real error".
- Stale-alias resilience differs by source: explicit flag throws; persistent env/default warn+fall-through.

**Known gaps flagged in review (2026-06-25):** env-path (step 3) and MCP raw-path fallback are unvalidated (no isVaultRoot check) — divergent UX vs aliases. No path normalization/`..` containment on registered paths (low risk: local trusted config, but worth noting for multi-user/hosted). resolveVaultPath does up to 3 readRegistry() disk reads in worst case (minor). No file lock across processes — last-writer-wins on concurrent `vault add` (atomic write prevents corruption, not lost updates).
