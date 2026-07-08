Deeply retrieve context from the **Context Nest** vault for the topic in
`$ARGUMENTS` and answer with citations. Use the Bash tool to run `ctx`.

## Steps

1. **Choose the vault.** If a vault is pinned, use it (`--vault <alias>`).
   Otherwise `ctx vault list --json` and pick the vault(s) whose `description`
   matches `$ARGUMENTS`.

2. **Build a selector.** Run `ctx search "$ARGUMENTS" --json` for seed node ids,
   map ids → tags via `ctx list --json`, and form a tag selector
   (`#a | #b`, `+` to AND, `-` to exclude).

3. **Load deeply.** Run `ctx query "<selector>" --hops 3 --json` (add
   `--vault <alias>` when chosen) to pull the documents and their related nodes.
   Widen the selector or `ctx read <id>` individual nodes if results are thin.

4. **Answer.** Summarize what the vault says about `$ARGUMENTS`, citing each point
   as `vault:id`. End with a one-line list of the node ids used. If the vault has
   nothing on the topic, say so directly.

This is a read-only recall — do not modify the vault.
