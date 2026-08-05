# MCPB bundle (Smithery stdio release)

Smithery distributes local stdio servers as a pre-built [MCPB](https://github.com/anthropics/mcpb)
bundle. Build it here, then publish the `.mcpb`.

```bash
cd mcpb
npm install --omit=dev @promptowl/contextnest-mcp-server@<version>   # vendors the server + deps
npx @anthropic-ai/mcpb pack . ../context-nest.mcpb
smithery mcp publish ../context-nest.mcpb -n promptowl/context-nest
```

The bundle vendors the **published npm package**, not the local workspace build — so
release to npm first, then build the bundle from that version.

`version` in `manifest.json` tracks `packages/mcp-server/package.json`; bump both together.

Smoke-test a built bundle without a client:

```bash
npx @anthropic-ai/mcpb unpack ../context-nest.mcpb /tmp/cn-bundle
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | CONTEXTNEST_VAULT_PATH=/path/to/vault \
    node /tmp/cn-bundle/node_modules/@promptowl/contextnest-mcp-server/dist/index.js
```
