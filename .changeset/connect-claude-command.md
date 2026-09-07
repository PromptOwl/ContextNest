---
"@promptowl/contextnest-cli": minor
---

`ctx connect claude`: one command between "I have a nest" and "Claude can query it".

Wiring a nest into Claude meant hand-assembling a `claude mcp add` line, an `.mcp.json` block, or a `claude_desktop_config.json` entry — and getting the transport, the URL and the bearer header right by hand. The new subcommand emits it for the nest the CLI already resolves to (`--vault`, `CONTEXTNEST_VAULT`, the registry default, or the vault you are standing in).

- `--surface code` (default) prints the `claude mcp add --transport http …` line. `--format json` prints the `.mcp.json` block instead, `--write [path]` merges that block into `./.mcp.json` (preserving the project's other servers), and `--run` executes the line.
- `--surface desktop` prints the paste-ready `claude_desktop_config.json` snippet, the config path on all three platforms, the quit-and-reopen reminder, and the `mcp-remote` stdio fallback for builds without remote MCP.
- `--surface web` prints the claude.ai custom-connector URL, and warns when the endpoint is not HTTPS or resolves only on the local network — the two reasons a web connector silently does nothing.
- A registered HTTP nest emits an HTTP server; a **local vault** emits the stdio MCP server over its path. `--name` overrides the server name, `--scope` passes through to `claude mcp add`.
- The configuration goes to stdout and the commentary to stderr, so `ctx connect claude | sh` and `ctx connect claude --format json > .mcp.json` both work.

**The credential is never printed.** It is taken from the registry entry's `bearer_env`/`header_env`, falling back to `CONTEXTNEST_API_KEY` — there is no `--key` flag, since argv is readable by other processes. The emitted config references the variable instead of its value: `$VAR` in the shell line (expanded by the user's shell, so shell history keeps the name) and `${VAR}` in the JSON blocks (expanded by Claude at read time, so the secret never lands in a committed file). The variable is read only to assert it is set — with no credential available the command errors and names the variable to export, rather than emitting an empty `Authorization` header that fails later as an opaque 401. A genuinely open nest takes `--no-auth`.
