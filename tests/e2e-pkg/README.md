# QA release-gate suite — `tests/e2e-pkg/`

**Owner:** QA / Test Automation.
**Not** the dev-owned in-repo regression suite (`packages/**/*.regression.test.ts`), and deliberately does not overlap it.

## What it is

A thin, product-level suite that proves the CLI is **safe to publish** — that it
packages, installs, and runs from a clean install, on every platform. Dev's
regression suite runs the *in-repo* build and so is blind, by construction, to
packaging failures. This suite closes that gap and nothing else.

It packs the real tarball (`npm pack`), installs it into a throwaway directory
with **no workspace on the path**, and drives the *installed* binary.

## What it guards (see `packaging.pkg.test.ts`)

| Case | Guards against |
|------|----------------|
| PKG-01 | tarball doesn't install into a clean dir |
| PKG-02 | `files` allowlist ships too little / leaks `src`/tests |
| PKG-03 | engine / zod / mcp-sdk (devDeps) stop being **bundled** by tsup — the classic "works in repo, broken on install" bug |
| PKG-04 | `bin` field drops `ctx` or `contextnest` |
| PKG-05 | CLI breaks when the optional `chalk` dep is absent |
| PKG-06 | published `--version` drifts from `package.json` |
| PKG-07 | installed bin can't `init` + `verify` a vault |
| PKG-08 | breadth journey — each command *group* once end-to-end (init → config → add → update → query → search → list → read → history → validate → verify) |

**Scope line:** depth (every command, all flags, negatives) stays in dev's
regression layer. This suite is breadth — touch each group once — plus install
integrity. It is not a second regression suite.

## When it runs

Gated to **release PRs / pre-publish**, on the CI OS × Node matrix
(ubuntu / windows / macOS × Node 20/22). Not on every push — it is slow (packs +
multiple clean installs) and needs network + `npm`.

## Run it locally

```bash
pnpm test:pkg          # builds the CLI, then runs this suite
```

Requires network access (the install resolves `commander` from the registry).
If you see a "dist/index.js is missing" error, build first:
`pnpm --filter @promptowl/contextnest-cli build`.
