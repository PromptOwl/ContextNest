---
"@promptowl/contextnest-cli": minor
---

Tasks on a remote (Community) nest: `ctx update --assignee/--due/--priority/--parent` (`""` or `none` clears), `ctx list --assignee/--priority/--due-before`, and `ctx task log <path> --note "…" [--status working|done|blocked] [--claim] [--agent <name>]`, which records an interaction on the task attributed to you, your API key and the agent. Against an older server that drops the arguments, the CLI reports it instead of claiming success. Local vaults refuse these flags, since an assignee has to be on a nest's roster.
