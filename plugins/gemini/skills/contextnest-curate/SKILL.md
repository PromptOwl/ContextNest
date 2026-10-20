---
name: contextnest-curate
description: Sweep the ContextNest vault to correct stale information or refile nodes across folders. Use when an architectural decision or fact has changed and all references need updating.
---

# ContextNest Vault Curation & Sweep

Update facts across the vault and prevent stale knowledge drift.

## Steps

1. **Locate All Stale References:** Find every node mentioning the old fact:
   ```bash
   ctx search "<old-term-or-fact>" --json
   ```

2. **Reconstruct & Review Prior State:** Check the current version of each affected node:
   ```bash
   ctx history <id> --json
   ```

3. **Update Nodes:** Read the existing raw body first to preserve unrelated content:
   ```bash
   ctx read <id> --raw
   ```
   Apply the update:
   ```bash
   ctx update <id> --body "<updated-content>"
   ```

4. **Refile if Structure Changed:** To move a node to another folder, verify structure rules on the target folder first:
   ```bash
   ctx structure --folder <target-folder> --json
   ctx move <id> <target-folder>
   ```

5. **Report Summary:** List all updated node IDs and note any held reviews for the user to approve.
