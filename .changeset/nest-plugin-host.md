---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
---

Nest Plugins: a plugin host in the engine and `ctx plugin` in the CLI.

Plugins written against `@promptowl/contextnest-plugin-sdk` (Apache-2.0) connect
outside sources — GitHub, Gong, Slack, Teams, email — to a vault. The engine's
new `@promptowl/contextnest-engine/plugins` export loads them, runs their
`pull` / `webhook` / `process` / `search` faces, maps items to nodes (raw, or
summarized through a host-supplied `distill` port with the raw item retained),
upserts them keyed on provenance (`metadata.provenance.plugin` + `externalId`),
and never overwrites a node a human has edited since the plugin's last write.
It populates the `sync` capability namespace of the operation catalog
(`context_plugins`, `context_ingest`, `context_ingest_item`,
`context_search_federated`, `context_promote`) via an `EngineExtension`, so
Community and the MCP/REST bindings get the same ops. Plugins get a wrapped
`fetch` that refuses loopback/private/link-local hosts and enforces a timeout
and per-run budget — a guard against SSRF mistakes in honest plugins, not a
sandbox: a plugin runs in-process, so loading one is the trust decision.

`ctx plugin add|list|set|remove|pull|search|promote` runs the same plugins
against a local vault. `add` is that trust decision: it records the module and a
hash of its file in `~/.contextnest/plugin-trust.json`, and every other command
refuses a plugin that was not added on this machine or has changed since — a
cloned or shared vault cannot run its own code on `ctx plugin list`.
Plain settings and cursors live in `.context/plugins.yaml`;
`x-secret` settings go to the secure credential store from `ctx login` (OS
keyring, else the encrypted file store) and never to that file, with
`CONTEXTNEST_PLUGIN_<NAME>_<KEY>` as the override and the fallback when no
secure store exists. Plaintext secrets an older build left in `plugins.yaml`
are migrated on the next write. Summary mode uses `CONTEXTNEST_DISTILL_URL`
when set.
