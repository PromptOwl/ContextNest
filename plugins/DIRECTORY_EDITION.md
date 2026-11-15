# Directory edition (this branch only)

This file exists only on the `directory` branch (outside `plugins/claude-code/`, so it is not shipped). If it is missing, you are on `development` and none of this applies.

The Claude plugin directory accepts command hooks only from Verified organizations, so `plugins/claude-code/` here ships no `hooks/`, `core/`, settings or `/contextnest:config`. It uses the `check-notes` and `keep-notes` skills instead. The full plugin stays on `development`.

## Merging

- **`development` into `directory`:** keep the deletions of `hooks/*` and `core/*` (they show as modify/delete conflicts whenever `plugins/shared/core` changes), and leave `core: false` in `scripts/sync-plugins.mjs`.
- **`directory` into `development`:** don't. It would delete the full plugin. The edition tests in `plugins/__tests__/structure.test.ts` run only when `plugins/claude-code/hooks` is absent, so they stay skipped on `development`.

## Versions

This branch carries its own `plugin.json` version and its own `CHANGELOG.md` section (0.9.x), ahead of `development`'s plugin version. When you change the edition, bump both here. When you merge `development` in, keep this branch's version and changelog entries.
