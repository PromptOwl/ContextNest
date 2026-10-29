---
"@promptowl/contextnest-engine": minor
"@promptowl/contextnest-cli": minor
"@promptowl/contextnest-mcp-server": minor
---

**Faster index regeneration on network storage; hosts can skip the agent config files.**

- `regenerateIndex` writes the agent config files (`CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`) side by side instead of one after another. They embed the document list, so they change on almost every write; on a GCS-mounted vault that loop cost about 1.3 s per save.
- New `NestStorage` option `agentConfigs` (default `true`). A host that serves the vault and never hands those files to a coding agent (the hosted Community server) passes `false`, and each write stops rewriting them. The CLI and MCP server keep the default, so nothing changes for local vaults.
