---
"@promptowl/contextnest-engine": patch
"@promptowl/contextnest-cli": patch
---

Reject `__proto__`, `constructor` and `prototype` as vault aliases

`registry.vaults` is a plain object keyed by a caller-supplied alias, and
`ALIAS_PATTERN` matched `__proto__`. Two consequences:

- `vaults["__proto__"]` returns `Object.prototype` — truthy, so it slipped past
  the `if (!entry)` guards. Writing to that entry altered `Object.prototype` for
  the whole process.
- `addVault("__proto__", path)` assigned through `vaults[alias] = entry`, which
  replaces the object's prototype rather than adding a key.

Aliases are now validated at every mutating entry point (`addVault`,
`removeVault`, `setDefaultVault`, `setVaultDescription`), and alias resolution
(`--vault`, `CONTEXTNEST_VAULT`, the MCP positional argument) does an
own-property lookup so a prototype member can never read back as a registered
vault. Reported by CodeQL (`js/prototype-polluting-assignment`).
