# Context Nest MCP server over stdio — for Glama.ai and any MCP client that
# runs servers as containers.
#
#   docker build -t contextnest-mcp .
#   docker run -i --rm contextnest-mcp                       # demo vault baked in
#   docker run -i --rm -v "$PWD:/vault" contextnest-mcp      # serve your own vault
#
# A mounted vault is the directory that contains `.context/config.yaml`. The
# server runs as uid 1000; add `--user "$(id -u):$(id -g)"` if your vault is
# owned by a different uid.

FROM node:20-alpine

# pnpm workspace repo: `npm ci` cannot resolve the `workspace:^` deps, and the
# build needs devDependencies (tsup/typescript), so no --omit=dev here.
# Version pinned to match CI (.github/workflows/ci.yml).
RUN npm i -g pnpm@9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Vault root for both the seed below and the server at runtime. Set explicitly
# because resolveVaultPath()'s cwd walk-up (precedence 5) would otherwise depend
# on how the client invokes the container.
ENV CONTEXTNEST_VAULT_PATH=/vault

# The write tools (create/update/delete/publish_document) touch the vault, so
# don't run them as root: files created in a bind-mounted host vault would come
# back root-owned. `node` (uid 1000) ships with the base image.
RUN mkdir /vault && chown node:node /vault
USER node

# ponytail: demo vault baked into the image so the Glama inspector has documents
# to read. Drop this line if the image should only ever serve a mounted vault.
RUN node packages/cli/dist/index.js init --name ContextNest --starter developer

ENTRYPOINT ["node", "/app/packages/mcp-server/dist/index.js"]
