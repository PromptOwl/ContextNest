# @promptowl/contextnest-engine

## 1.1.1

### Patch Changes

- Patch release with reliability fixes for vault init and history crawl.

  **@promptowl/contextnest-cli**

  - `ctx init` now targets the current working directory instead of walking up to find an ancestor vault. Initializing a vault is always a "create here" operation; walking up could resolve to a stray ancestor `.context/config.yaml` (e.g. `~/.context/config.yaml`) and misresolve init to the wrong directory. The `CONTEXTNEST_VAULT_PATH` env override still wins.

  **@promptowl/contextnest-engine**

  - Harden `findAllHistories()` and `readPacks()` against unreadable directories. Both crawls now pass `suppressErrors: true` to `fast-glob` so a single permission-denied directory under the vault root no longer crashes checkpoint rebuild or pack loading.

  **@promptowl/contextnest-mcp-server**

  - Internal: picks up the engine reliability fixes above (no surface API change).
