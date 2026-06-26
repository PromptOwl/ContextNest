---
name: engine-conventions
description: Engine package conventions — structured error hierarchy, Zod schemas, export surface, env-var naming
metadata:
  type: project
---

**Errors** (`packages/engine/src/errors.ts`): all extend `ContextNestError(message, code, specSection?)`. Each subtype sets `.name` and a stable `code` (e.g. CONFIG_ERROR, INTEGRITY_ERROR, UNKNOWN_ALIAS via ConfigError subtype). Spec section referenced in `specSection`. Prefer adding a typed subtype over message-string matching when callers must branch on error kind.

**Schemas**: Zod schemas with `.safeParse` + issue-path-joined error messages (see `vaultRegistrySchema`). `.default(...)` used for optional/back-compat fields.

**Exports**: everything public re-exported from `packages/engine/src/index.ts` (types via `export type`, values separately). CLI and MCP import only from `@promptowl/contextnest-engine`, never deep paths.

**Env vars**: `CONTEXTNEST_*` prefix. `CONTEXTNEST_CONFIG_DIR` (registry/sandbox), `CONTEXTNEST_VAULT` (alias), `CONTEXTNEST_VAULT_PATH` (path), `CONTEXTNEST_NO_BROWSER`. Empty-string treated as unset (relies on JS falsy `||` / `if`).

**Tests**: Vitest. Engine tests sandbox via `CONTEXTNEST_CONFIG_DIR` under `mkdtempSync` tmp dir, save/restore env in beforeEach/afterEach. CLI tests are integration-style: `execFileSync('node', [dist/index.js, ...])` against the BUILT dist — so CLI tests require a prior `pnpm build` and won't reflect uncommitted src changes.

**Multi-target agent files**: `ctx index` writes managed sections into CLAUDE.md/GEMINI.md/.cursorrules/.windsurfrules/.github/copilot-instructions.md, gated by NestConfig.agent_tools.
