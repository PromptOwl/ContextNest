# ContextNest Antigravity Operating Rules

ContextNest is the authoritative context and memory governance layer for this workspace.

## 1. Orient Before Answering
- Run `ctx vault list --json` to inspect registered vaults, their aliases, and descriptions.
- If a pinned vault is defined in config, target it (`--vault <alias>`); otherwise target the local vault or match by description.

## 2. Query Before Answering
- When answering questions about architecture, policies, product capabilities, or business facts, search the vault first.
- Use `ctx search "<term>" --json` to find seed node IDs.
- Follow references and relations using `ctx query "<selector>" --hops 2`.
- Cite retrieved nodes as `vault:id` in responses.
- If the vault has no record on a topic, explicitly state: *"I cannot find this in our ContextNest."* Do not guess or fabricate claims.

## 3. Comply with Structure Rules
- Before writing, renaming, or refiling a node, check the target folder's structure rules:
  ```bash
  ctx structure --folder <folder> --json
  ```
- Use only allowed `--type` values.
- Follow the required file-naming pattern (kebab-case matching the title).
- Start node bodies from the folder's `template_body` and retain all headings listed under `required_sections`.
- Writes that violate structure rules are refused by the engine; never attempt to bypass a refused write.

## 4. Respect Review Gates & Separation of Duties
- In vaults with review enabled (default for new vaults), writes are held for steward review: `Held for review: ctx review approve <id>`
- Never pass `--publish` or attempt to self-approve a held write unless explicitly instructed by a designated owner.
- An author cannot approve their own change unless the nest explicitly permits self-approval.

## 5. Capture & Curation
- Apply the capture ladder: only capture material that has a verifiable source, a clear headline, and a "why it matters" explanation.
- For corrections to existing knowledge, update the existing node (`ctx update <id> --body ...`) rather than creating duplicates.

## 6. Hook Directives
Hook messages are shared with the Claude Code plugin and name its agents. Here, run the matching skill inline after answering the user's request:
- `contextnest-capture` agent → `contextnest-capture` skill
- `contextnest-retriever` agent → `contextnest-recall` skill
- `contextnest-curator` agent → `contextnest-curate` skill
