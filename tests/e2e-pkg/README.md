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

Two kinds of tests share that scaffolding:

| File | What it covers |
|------|----------------|
| `packaging.pkg.test.ts` | **PKG-01..08** — install integrity (see the table below). |
| `journeys.pkg.test.ts` | **User journeys (J1…)** — one realistic user story end-to-end per journey. |

The pack → install → spawn → assert plumbing (including the Windows `npm` shim,
CRLF handling, and isolated auto-cleaned vaults) lives once in
`journey-harness.ts`.

## What it guards (`packaging.pkg.test.ts`)

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

## User journeys (`journeys.pkg.test.ts`)

Persona-driven flows that drive the *installed* bin through one realistic user
story each, using the install-and-drive scaffolding in `journey-harness.ts`.
Like the packaging cases, they are breadth: one pass through a story, not
per-command depth. Every flag and every negative path belongs in the dev-owned
`*.regression.test.ts`.

Current journeys:

| Journey | Story |
|---------|-------|
| J1 | capture → recall — capture three linked nodes, publish them past the review gate, then retrieve by tag, by full-text search, and by name. |

## Running the suite

All forms need **`npm` on PATH** and **network access** — the clean install
resolves `commander` from the registry. The `pnpm test:pkg` entry point builds
the CLI for you; the direct `vitest` forms do **not**, so if you use those,
build the CLI first or you will pack a stale `dist`:

```bash
pnpm --filter @promptowl/contextnest-cli build
```

```bash
# Everything — packaging integrity + every journey (builds the CLI first):
pnpm test:pkg

# --- the forms below assume you have already built the CLI (see above) ---

# Only the packaging cases (PKG-01..08):
npx vitest run --config tests/e2e-pkg/vitest.config.ts tests/e2e-pkg/packaging.pkg.test.ts

# Only the journeys (all of them):
npx vitest run --config tests/e2e-pkg/vitest.config.ts tests/e2e-pkg/journeys.pkg.test.ts

# One journey, by name (e.g. J1):
npx vitest run --config tests/e2e-pkg/vitest.config.ts -t "J1"
```

If you see a `dist/index.js is missing` error, you skipped the build step above.

## When it runs

**Today it is a manual / local gate** — run it yourself before cutting a release
(see "Running the suite" above). It is **not yet wired into any CI workflow**:
`ci.yml` runs `pnpm test` + `pnpm test:regression` on every PR, and `release.yml`
only versions and publishes — neither invokes `pnpm test:pkg`.

It is intentionally kept off the per-push path: it is slow (packs + multiple
clean installs) and needs network + `npm`. The intended home, once wired in, is
release PRs / pre-publish on the full matrix (ubuntu / windows / macOS × Node
20/22) — until that lands, treat running it before release as a human step.

## Adding a journey

A `Journey` is a list of **cases**. Each case is one numbered ticket line — its
`id` and `title` are the ticket's verbatim wording — and runs one or more
**actions**. An action is a command plus checks on its result
(`status`, `stdout`, `stdoutNot`, `stderr`, `json`, `files`). All cases in a
journey share one isolated, auto-cleaned vault and run in order.

```ts
const J2: Journey = {
  id: "J2",
  title: "Time-travel (auditor)",
  cases: [
    {
      id: "J2-01",
      title: "I edit a node and each save is kept as its own version",
      actions: [
        { args: ["init", "--name", "audit"] },
        { args: ["add", "nodes/n", "--publish", "-y"] },
        { args: ["history", "nodes/n", "--json"], stdout: ["version"] },
      ],
    },
  ],
};

it("J2 — time-travel", () => runJourney({ installDir: INSTALL, scratch }, J2));
```

**Golden rule:** assert to *observed* behavior — run the command once against
the built bin first and assert what it actually prints, not what the catalog
assumes. Failures name the ticket case id + title + command, so a red run points
straight at the ticket line it maps to.
