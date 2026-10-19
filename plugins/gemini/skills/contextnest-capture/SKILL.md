---
name: contextnest-capture
description: Capture insights, architectural decisions, bug root-causes, or team agreements directly into ContextNest. Use when the user asks to remember or save information to ContextNest or the vault.
---

# ContextNest Knowledge Capture

Explicitly capture valuable knowledge, architectural decisions, or verified facts into ContextNest.

## Steps

1. **Verify the Capture Ladder:**
   Before creating a node, verify:
   - Does this already exist in the vault? Run `ctx search "<keyword>" --json`. If so, update the existing node rather than duplicating.
   - Can this be stated with a clear title, a single-sentence headline, and a "why it matters" explanation?
   - Is the source verified?

2. **Check Structure Rules:**
   Check the destination folder's structure rules:
   ```bash
   ctx structure --folder <target-folder> --json
   ```
   Ensure:
   - The `--type` is permitted in that folder.
   - The file name / title matches the required format (e.g. kebab-case matching title).
   - Any required sections or frontmatter headers are included.

3. **Write the Node:**
   Create the node via the `ctx` CLI:
   ```bash
   ctx add <id> --title "<Title>" --type <type> --tags "#tag1,#tag2" --body "..."
   ```

4. **Report Status:**
   - If the write published directly: report `captured: vault:<id> — <title>`.
   - If held for review: report `held for review: vault:<id> — <title> · approve: ctx review approve <id>`.
