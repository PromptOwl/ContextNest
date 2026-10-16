---
name: contextnest-structure
description: Inspect and validate ContextNest structure rules, allowed folder taxonomies, naming conventions, and frontmatter templates. Use when organizing or planning new vault folders.
---

# ContextNest Structure Rules Inspection

Validate folder layouts and retrieve required frontmatter templates before adding content.

## Steps

1. **Inspect Vault Structure Rules:**
   Run the structure command to inspect the vault's governance blueprint:
   ```bash
   ctx structure --json
   ```

2. **Inspect Specific Folder Rules:**
   To retrieve allowed types, naming formats, and starter template for a folder:
   ```bash
   ctx structure --folder <folder-path> --json
   ```

3. **Verify Compliance:**
   Check:
   - Is the folder open or closed? (If closed, new unmapped folders cannot be created).
   - What node types are allowed?
   - What regex or format is required for file names?
   - What sections are marked required?
