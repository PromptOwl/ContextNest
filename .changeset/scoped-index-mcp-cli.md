---
"@promptowl/contextnest-mcp-server": patch
"@promptowl/contextnest-cli": patch
---

**Approving a suggestion, holding a write for review, changing a status and deleting rewrite only that document's folder index.** The MCP server's suggestion-approval, held-write, status-update and delete tools, and `ctx drift approve`, rebuilt every folder's INDEX.md after changing a single document. They now rewrite only the folder that document lives in; `context.yaml` is still rebuilt in full. This matches what publishing already does.
