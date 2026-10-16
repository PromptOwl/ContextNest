---
name: contextnest-recall
description: Deeply retrieve ContextNest vault knowledge for a topic and answer with authoritative citations. Use when the user asks questions about architecture, policies, product capabilities, or business facts.
---

# ContextNest Vault Recall

Deeply retrieve context from the **ContextNest** vault for a topic and answer with citations.

## Steps

1. **Identify the Target Vault:**
   Run `ctx vault list --json` to list registered vaults. If a vault alias is specified or pinned in config (`CONTEXTNEST_VAULT_ALIAS`), pass `--vault <alias>`. Otherwise, select the vault whose description matches the topic.

2. **Search for Seed Nodes:**
   Run full-text search to find relevant nodes:
   ```bash
   ctx search "<topic>" --json
   ```

3. **Traverse Graph Dependencies (Deep Retrieval):**
   Map matching node IDs to tags and run a graph query:
   ```bash
   ctx query "<tag-or-selector>" --hops 2 --json
   ```
   Read individual nodes directly with `ctx read <id> --raw` if needed.

4. **Synthesize and Cite:**
   Summarize what the vault states, citing each fact as `vault:<id>`.
   If the vault has no records matching the query, state: *"I cannot find this in our ContextNest."*
