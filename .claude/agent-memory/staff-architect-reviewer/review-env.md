---
name: review-env
description: Sandbox constraints during review — which Bash commands are denied
metadata:
  type: project
---

In this review sandbox: `git fetch origin` is DENIED, and `pnpm build`/`pnpm test`/`pnpm lint` (and `pnpm --filter ... lint/test`) are DENIED. Read-only git (`git log`, `git diff`, `git status`, `git diff origin/development...HEAD`) and `grep`/Read work fine.

**How to apply:** Don't promise to run build/test — state up front they couldn't be executed and rely on static analysis. `origin/development` ref is already present locally (fetched before sandbox), so `git diff origin/development...HEAD` works without a fresh fetch. Note that CLI integration tests run against built `dist/`, so they can't be exercised here anyway.
