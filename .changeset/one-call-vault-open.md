---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

Opening a vault takes one call, and `context_overview` is gone

`context_init` returned only `CONTEXT.md`, `context_overview` returned counts and
a node list, and neither returned the vault's configuration — so an agent opening
a vault made two round trips and still could not see the config. Meanwhile the
`vault_info` alias sat on `context_overview`, an operation that returns none of
what `vault_info` returns.

`context_init` now answers both halves of "open this vault" in one call: its
`CONTEXT.md` instructions, its configuration (name, description, declared MCP
servers), its path, and what it holds — total, counts by type and status, and the
tag set. The node list itself is opt-in behind `include_nodes` (with `limit`),
because counts and tags answer most opening questions and a large vault's node
list dwarfs them. `vault_info` now aliases this operation, which actually returns
what that name promises.

`context_overview` is **removed**. Everything it returned, `context_init` returns.

`context_init` also counts retired nodes. It discovers with `includeRetired`, so
`by_status` can report `rejected` at all — the manifest previously omitted a whole
status rather than reporting zero, the same defect `context_list` carried.

`context_init`, `context_verify` and `context_packs` are registered as MCP tools;
`vault_info` and `verify_integrity` keep their exact behaviour and are deprecated
in favour of the first two.

New CLI command `ctx info` shows a vault's instructions, configuration and
contents (`--nodes` to list them, `--json` for the raw payload). It is
deliberately **not** called `ctx init`: that command *creates* a vault, where this
one opens an existing one — same word, opposite meaning.

`ctx verify` deliberately does **not** move onto `context_verify`. It verifies
each document chain itself and reports unreadable histories per document, which is
strictly more than the operation's vault-level integrity check; routing it through
the catalog would have lost that.
