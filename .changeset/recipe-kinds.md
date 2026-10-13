---
"@promptowl/contextnest-cli": minor
---

Recipes can carry a `kind:` section: plugins, edge types, edges, schedules, steward seats (placeholders) and the runner handlers a package expects. The section is validated as strictly as the rest of a manifest, with unknown fields and secret-looking plugin settings refused. `ctx pull` writes it to `nodes/kinds/<recipe-id>` as a draft with lineage. The new `ctx kind apply <id> --server --nest` maps it onto a Community server's REST API. It only prints the plan unless you pass `--yes`, skips any plane the server has switched off with a clear warning, never sends secrets or enables plugins, and applies stewards only once their placeholders are mapped with `--steward @placeholder=email`.
