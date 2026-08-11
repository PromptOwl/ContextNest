---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

Flatten the dependency tree and publish the dependency graph.

Installing the CLI now pulls **10 packages at a maximum depth of 3**, down from 104 packages at depth 7. Four dependencies were removed without losing any behaviour:

- `unified` / `remark-parse` / `remark-gfm` (58 packages) — the markdown AST was used only to find `contextnest://` links and section headings, which a fence-aware line scanner does directly.
- `fast-glob` (18 packages) — replaced by a small `*` / `**` matcher over a `readdir` walk.
- `gray-matter` (11 packages) — frontmatter is split in-tree and parsed with the `js-yaml` the engine already depended on, instead of a second, older copy of it.
- `cli-table3` (7 packages) — declared but never imported.

Alongside that:

- **No install scripts.** The CLI's `postinstall` banner is gone; installing the package now executes none of our code. The same guidance is one `ctx` away in the top-level help.
- **Minimal install profile.** `chalk` moved to `optionalDependencies`, so `npm install -g @promptowl/contextnest-cli --omit=optional` installs a colour-free CLI with every command, flag and output format unchanged.
- **Published dependency graph.** `DEPENDENCIES.md` records every runtime package, why it is there, and its licence. CI regenerates it and fails on drift, and uploads the machine-readable graph as a build artifact.
