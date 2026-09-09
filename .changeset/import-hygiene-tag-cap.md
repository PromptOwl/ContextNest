---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

Cap the tag list in generated agent configs, and make folder import produce nodes that validate.

The `## Vault Overview` block written into CLAUDE.md (and the other agent config files) listed every tag in the vault — around 700 on a real vault, malformed ones included — and became the bulk of the agent's system prompt. It now lists the 40 most-used tags (ties alphabetical) followed by `… and N more (run ctx list --json for all)`, and leaves out any tag that fails the spec's tag rule (§13 rule 5), since such a tag cannot be queried anyway.

`context_import` used to land whatever a notes tool exported: files named `Untitled 1.md` or `?tab=t.vdb3f3osszzz.md` became nodes at those ids, frontmatter with no `title`, `type: note`, and hashtag lists pasted into one tag all went through as-is — so `ctx validate` failed on the vault and `ctx list` printed `undefined`. Import now repairs the minimum needed for each node to validate and reports every repair in a new `warnings: string[]` on the result:

- Paths sent through `files[]` are slugified segment by segment (`nodes/Dr. Smith.md` → `nodes/dr-smith.md`, `nodes/?tab=t.vdb3f3osszzz.md` → `nodes/tab-t-vdb3f3osszzz.md`); already-clean segments and dot-directories such as `.versions` are untouched, so an exported version chain still lines up with its document. Two files that slugify alike are kept apart (`-2`, `-3`), and a document renamed that way takes its `.versions/<stem>/` history with it rather than leaving it in another document's directory.
- A path already in the vault is not overwritten: the incoming file lands beside it as `<name>-2`, with a warning. Set the new `overwrite: true` to replace it instead — which is what a retried batch, or a caller using `files[]` as an update path, wants.
- A missing `title` is derived from the body's first `# heading`, else from the original filename with its casing intact (`Dr. Smith`).
- A missing `type` is written as `document` (deliberate, so `type:document` selectors reach imported notes); a `type` outside the spec's node types is coerced to `document` with a warning.
- Tags that fail the tag rule are dropped with a warning; an entry containing `#` is split into its hashtags first, so `"#gtm #contextnest"` becomes two tags rather than one invalid one.
- The same frontmatter repairs apply on `discover`, for documents a caller wrote into the vault itself.
- A file whose frontmatter is already valid and states its `type` is written byte for byte, as before.

`ctx list` prints `(untitled)` instead of `undefined` for a node that has no title, so existing vaults with such nodes remain readable. Rewriting those existing nodes (`ctx validate --fix`) is a follow-up.
