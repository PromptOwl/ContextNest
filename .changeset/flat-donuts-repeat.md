---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-mcp-server": minor
"@promptowl/contextnest-cli": minor
---

Flatten the dependency tree and publish the dependency graph.

Installing the CLI now pulls **2 packages with no nesting** (1 with `--omit=optional`), down from 104 packages at depth 7. **The MCP server installs nothing at all**, down from 97 packages at depth 11.

The CLI and MCP server are binaries, not libraries, so their dependencies are now compiled into `dist/` and declared as devDependencies. Unused code is dropped in the process — the MCP server no longer ships the SDK's express, hono, ajv and jose transports, none of which a stdio server touches. Every bundled package is listed with its version and licence in `DEPENDENCIES.md`, so nothing is hidden by being bundled.

The engine is a library and keeps real dependencies — 7 packages at depth 2, down from 76. Four were removed outright without losing any behaviour:

- `unified` / `remark-parse` / `remark-gfm` (58 packages) — the markdown AST was used only to find `contextnest://` links and section headings, which a fence-aware line scanner does directly.
- `fast-glob` (18 packages) — replaced by a small `*` / `**` matcher over a `readdir` walk.
- `gray-matter` (11 packages) — frontmatter is split in-tree and parsed with the `js-yaml` the engine already depended on, instead of a second, older copy of it.
- `cli-table3` (7 packages) — declared but never imported.

Alongside that:

- **No install scripts.** The CLI's `postinstall` banner is gone; installing the package now executes none of our code. The same guidance is one `ctx` away in the top-level help.
- **Minimal install profile.** `chalk` moved to `optionalDependencies`, so `npm install -g @promptowl/contextnest-cli --omit=optional` installs a colour-free CLI — a single package — with every command, flag and output format unchanged.
- **Published dependency graph.** `DEPENDENCIES.md` records every installed and bundled package, why it is there, and its licence. CI regenerates it and fails on drift, verifies that every module a published bundle imports is a declared dependency, and uploads the machine-readable graph as a build artifact.
