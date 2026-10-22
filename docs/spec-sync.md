# Publishing the spec to PromptOwl/context-nest-spec

`CONTEXT_NEST_SPEC.md` is written here and published, under Apache-2.0, at
[PromptOwl/context-nest-spec](https://github.com/PromptOwl/context-nest-spec).
The workflow `.github/workflows/sync-public-spec.yml` keeps the two in step so
the public copy cannot quietly fall a version behind.

## The flow

1. A commit lands on `main` that changes `CONTEXT_NEST_SPEC.md` (or
   `LICENSE-SPEC`, which only triggers a run — it is never copied).
2. The **sync** job:
   - runs the tests in `scripts/spec-sync/`;
   - transforms the spec with `scripts/spec-sync/transform-spec.mjs`. The only
     rewrite is the licence line (this repo points at `LICENSE-SPEC`, the spec
     repo points at its own `LICENSE` and links back here). The match is exact:
     if the licence line changes, the script fails and you update
     `SOURCE_LICENSE_LINE` / `PUBLIC_LICENSE_LINE` together;
   - runs the licence & leak guard (below) on the transformed file;
   - clones context-nest-spec with `SPEC_SYNC_TOKEN`. If `main` there already
     matches, it exits green with "no changes" (and closes a stale sync PR if
     one is open);
   - otherwise commits on the fixed branch `sync/contextnest-spec`,
     force-pushes it, and opens the PR — or edits the open one. Title:
     `Sync spec from ContextNest@<sha> (spec v<version>)`.
   - It never merges. A person reviews and merges the PR, then tags
     `v<version>` on context-nest-spec if the version changed (the PR body says
     so).
3. The **drift** job runs every Monday (and on demand). It transforms
   ContextNest `main` and compares it with context-nest-spec `main`. Any
   difference fails the run red, with the diff in the job summary — so drift is
   visible even when a sync PR sits unmerged.

Every run writes a job summary: source commit, spec version, lines +/−, the PR
link or "no changes", and the guard results.

## Licence boundary

The spec text is PromptOwl-authored and dual-published: Apache-2.0 in
context-nest-spec, `LICENSE-SPEC` here. The engine, CLI and MCP server in this
repository are AGPL-3.0 and must never reach the Apache-2.0 repo. The workflow
enforces that, fail-closed:

- **Path allowlist.** The sync writes exactly one file in context-nest-spec,
  `CONTEXT_NEST_SPEC.md`. It checks `git status` before committing and the
  commit's file list after; anything else fails the run. The spec repo keeps
  its own `LICENSE`.
- **Licence & leak guard** (`scripts/spec-sync/guard-spec.mjs`), run before any
  push and again by the drift job. It fails on:
  - (a) fenced code blocks tagged with a programming language (`ts`, `js`,
    `mjs`, `py`, `rust`, `go`, `java`, `c`, `cpp`, `csharp`, …). The spec's
    `yaml`, `markdown`, `bash` and unlabeled example blocks are allowed;
  - (b) any run of 5 or more non-trivial lines (≥ 20 characters, not
    brace-only, not comment-only) that also appears in `packages/*/src/**` or
    `packages/*/bin/**` — normalized-line shingles, so re-indenting or
    interleaving blank lines does not hide a copy;
  - (c) `SPDX-License-Identifier`, `AGPL`, `GNU Affero` or `Copyright (c)` on
    any line except the exact allowlisted ones (the licence line and the §15
    components table, in `LICENCE_LINE_ALLOWLIST`);
  - (d) `@promptowl/contextnest-*` references, relative `from './…'` imports,
    ES `import … from` statements and `require(`;
  - internal details: home-directory paths, internal or private IPs,
    `localhost:` URLs, email addresses outside `example.com/.org/.net`, the
    internal Slack workspace, and `cnst_` keys.

If the guard flags a legitimate spec change (say, a new row in the §15 table),
update the allowlist in `guard-spec.mjs` and its tests in the same PR, so the
change gets a reviewer.

Run the tests locally:

```bash
node --test scripts/spec-sync/transform-spec.test.mjs scripts/spec-sync/guard-spec.test.mjs
```

## The secret: `SPEC_SYNC_TOKEN`

A repository secret on PromptOwl/ContextNest. The workflow's own
`GITHUB_TOKEN` stays read-only (`permissions: contents: read`); this token is
the only thing that can write, and only to context-nest-spec.

Create it as a **fine-grained personal access token**:

- Resource owner: `PromptOwl`
- Repository access: **Only select repositories** → `PromptOwl/context-nest-spec`
- Repository permissions: **Contents: Read and write**, **Pull requests: Read
  and write** (Metadata: Read is added automatically). Nothing else.
- Expiration: 90 days or less is a good default; one year at most.

Then add it at ContextNest → Settings → Secrets and variables → Actions → New
repository secret, name `SPEC_SYNC_TOKEN`. If the organization requires
approval for fine-grained tokens, an org owner approves it under Organization
settings → Personal access tokens.

The sync PRs are authored by the token's owner, so use a bot or service
account if you have one. If the secret is missing, the sync job fails at its
first step with a message naming it.

### Rotating it

1. Create a new token with the same settings.
2. Replace the value of `SPEC_SYNC_TOKEN` (same name, new value).
3. Actions → **Sync public spec** → Run workflow, branch `main`, mode `sync`.
   It should go green with "no changes" or an updated PR link.
4. Revoke the old token.

## Running it by hand

Actions → **Sync public spec** → Run workflow (from `main`):

- mode `sync`: a dry run of the full path. With nothing to publish it ends
  green with "no changes"; otherwise it opens or updates the sync PR.
- mode `drift`: compares the two published files and fails red on any
  difference.
